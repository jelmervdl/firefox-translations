import compat from '../shared/compat.js';
import { lazy } from '../shared/func.js';
import Recorder from './Recorder.js';
import preferences from '../shared/preferences.js';
import { detectLanguage } from '../shared/langid.js'
import { MessageHandler, DefaultMap } from '../shared/common.js';
import { StorageArea } from '../shared/storage.js';


function isSameDomain(url1, url2) {
    return url1 && url2 && new URL(url1).host === new URL(url2).host;
}

async function isTranslatedDomain(url) {
    const {alwaysTranslateDomains} = await preferences.get({alwaysTranslateDomains: []});
    return url && alwaysTranslateDomains.includes(new URL(url).host);
}

// Give content-script access to session storage
// compat.storage.session.setAccessLevel(compat.storage.TRUSTED_AND_UNTRUSTED_CONTEXTS);

/*
function updateActionButton(event) {
    switch (event.target.state.state) {
        case State.TRANSLATION_AVAILABLE:
        case State.TRANSLATION_IN_PROGRESS:
        case State.TRANSLATION_ABORTED:
            compat.action.enable(event.target.id);
            break;
        case State.TRANSLATION_NOT_AVAILABLE:
            compat.action.disable(event.target.id);         
            break;
        default:
            break;
    }
}

function updateMenuItems({data, target: {state}}) {
    // Only let the active tab make decisions about the current menu items
    if (!state.active)
        return;

    // Only if one of the relevant properties changed update menu items
    const keys = ['state', 'models', 'from', 'to', 'active'];
    if (!keys.some(key => key in data))
        return;

    // Enable translate if the page has translation models available
    compat.contextMenus.update('translate-selection', {
        visible: state.models?.length > 0
    });

    // Enable the outbound translation option only if translation and
    // backtranslation models are available.
    compat.contextMenus.update('show-outbound-translation', {
        visible: state.models?.some(({from, to}) => from === state.from && to === state.to)
              && state.models?.some(({from, to}) => from === state.to && to === state.from)
    });
}
*/

/**
 * Session storage per tab. Used for state.
 *@type {Map<Number,StorageArea>}
 */
const session = new DefaultMap((tabId) => {
    return new StorageArea('session', `tab:${tabId}`);
});

/**
 * Supported translation providers
 * @type{[name:String]:Promise<Type<TranslationHelper>>}
 */
const providers = {
    // Chrome-compatible implementation which runs the Worker inside an offscreen page
    ...(chrome?.offscreen ? {wasm: async () => (await import('./WASMOffscreenTranslationHelper.js')).default} : {}),
    // Qt application running in headless mode on the user's machine
    ...(compat.runtime.connectNative ? {translatelocally: async () => (await import('./TLTranslationHelper.js')).default} : {}),
    // Normal implementation: uses Worker directly
    ...(globalThis?.Worker ? {wasm: async () => (await import('./WASMTranslationHelper.js')).default} : {}),
};

// Instantiation of a TranslationHelper. Access it as if it is a promise.
const provider = lazy(async (self) => {
    let {provider:preferred} = await preferences.get({provider: 'wasm'})

    if (!(preferred in providers)) {
        console.info(`Provider ${preferred} not in list of supported translation providers. Falling back to 'wasm'`);
        preferred = 'wasm';
        preferences.set({provider: preferred}, {
            silent: true // Don't trigger the `provider.reset()` down below
        });
    }
    
    let {options} = await preferences.get({options: {
        workers: 1, // be kind to the user's pc
        cacheSize: 20000, // remember website boilerplate
        useNativeIntGemm: true // faster is better (unless it is buggy: https://github.com/browsermt/marian-dev/issues/81)
    }});

    const implementation = await providers[preferred]();

    const provider = new implementation(options);

    provider.onerror = err => {
        console.error('Translation provider error:', err);

        compat.runtime.sendMessage({
            command: 'Error',
            data: err
        });

        // Try falling back to WASM is the current provider doesn't work
        // out. Might lose some translations the process but
        // InPageTranslation should be able to deal with that.
        if (preferred !== 'wasm') {
            console.info(`Provider ${preferred} encountered irrecoverable errors. Falling back to 'wasm'`);
            preferences.delete('provider');
            self.reset();
        }
    };

    self.onReset(() => provider.delete());

    return provider;
});

// When the provider preference is changed in the options page, reload the
// translation engine.
preferences.listen(['provider'], () => provider.reset());

const recorder = new Recorder();

// Download progress per tab, per download
const downloadProgress = new Map()

// Progress per tab, per content script. We can't reset the tab counts to 0 on
// navigation because it might be a web-app. We also have to account for
// multiple content scripts per tab in case of frames. So the only indicator
// of resetting a count is the content script disconnecting. Thus we keep a
// count per content script, but grouped by tab for ease.
const translationProgress = new DefaultMap(tabId => new Map());

// Connection to popup per tab
const popups = new Map();

function updatePopupTranslationProgress(tabId) {
    popups.get(tabId)?.postMessage({
        command: 'Progress',
        data: Array.from(translationProgress.get(tabId).values()).reduce(
            (acc, count) => ({
                pendingTranslationRequests: acc.pendingTranslationRequests + count.pending,
                totalTranslationRequests:   acc.totalTranslationRequests   + count.total
            }),
            {
                pendingTranslationRequests: 0,
                totalTranslationRequests: 0
            })
    });
}

function updatePopupDownloadProgress(tabId) {
    const downloads = downloadProgress.get(tabId)?.values() || [];
    popups.get(tabId)?.postMessage({
        command: 'Progress',
        data: Array.from(downloads).reduce((acc, download) => ({
            modelDownloadRead: acc.modelDownloadRead + download.read,
            modelDownloadSize: acc.modelDownloadSize + download.size
        }),
        {
            modelDownloadRead: 0,
            modelDownloadSize: 0
        })
    });
}

let serial = 0;

/**
 * Connects the port of a content-script or popup with the state management
 * mechanism of the tab. This allows the content-script to make UpdateRequest
 * calls to update the state, and receive state updates through Update messages.
 */
function connectContentScript(contentScript) {
    // Mark all requests with a number so we know which to remove from the queue.
    let connection = ++serial;

    const tabId = contentScript.sender.tab.id;

    const handler = new MessageHandler(callback => {
        contentScript.onMessage.addListener(callback)
    });

    // Track translation progress
    const counts = {pending: 0, total: 0};
    translationProgress.get(tabId).set(contentScript, counts);

    // If the content-script stops (i.e. user navigates away)
    contentScript.onDisconnect.addListener(async () => {
        const cancelled = connection;
        connection = null;

        // Remove progress counts for this connection
        translationProgress.get(tabId).delete(contentScript);
        if (translationProgress.get(tabId).size === 0)
            translationProgress.delete(tabId);
        updatePopupTranslationProgress(tabId);

        // Prune any pending translation requests that have this same
        // signal from the queue.
        if (provider.instantiated)
            provider.then(translator => translator.remove('connection', cancelled));
    });

    handler.on("TranslateRequest", async (data) => {
        // Update translation state stats for this tab
        counts.pending += 1;
        counts.total += 1;
        updatePopupTranslationProgress(tabId);

        // If we're recording requests from this tab, add the translation
        // request. Also disabled when developer setting is false since
        // then there are no controls to turn it on/off.
        Promise.all([
            preferences.get({developer:false}),
            session.get(tabId).get({record: false})
        ]).then(([{developer}, {record}]) => {
            if (developer && record)
                recorder.record(data);
        });

        try {
            const translator = await provider
            const response = await translator.translate({...data, connection});
            if (response.request.connection === connection) {
                contentScript.postMessage({
                    command: "TranslateResponse",
                    data: response
                });
            }
        } catch(e) {
            // Catch error messages caused by the disconnect
            if (e?.message === 'removed by filter' || e?.request?.connection !== connection)
                return;

            console.error('Error during translation', e);

            // Tell the requester that their request failed.
            contentScript.postMessage({
                command: "TranslateResponse",
                data: {
                    request: data,
                    error: e.message
                }
            });
            
            // TODO: Do we want the popup to shout on every error?
            // Because this can also be triggered by failing Outbound
            // Translation!
            compat.runtime.sendMessage({
                command: 'Error',
                data: e
            });
        } finally {
            // TODO what if we just navigated away and all the
            // cancelled translations from the previous page come
            // in and decrement the pending count of the current
            // page?
            counts.pending -= 1;
            updatePopupTranslationProgress(tabId);
        }
    });
}

async function connectPopup(port) {
    const tabId = parseInt(port.name.slice('popup-'.length));

    // Tell popup which translation models are available
    provider.then(async (translator) => {
        port.postMessage({
            command: 'Models',
            data: await translator.registry
        })
    });

    popups.set(tabId, port);
    updatePopupDownloadProgress(tabId);
    updatePopupTranslationProgress(tabId);

    // Note: all other state is synced through chrome.storage.session. Only
    // progress is not because it is very chatty, and only relevant when the
    // background page exists so there's no reason to store it in session.

    // Stop progress updates if the popup is closed
    port.onDisconnect.addListener(() => {
        if (popups.get(tabId) === port)
            popups.delete(tabId);
    });
}

// Receive incoming connection requests from content-script and popup.
// The content script connection is used only for translation. If the
// connection is dropped (page unload, tab closed, etc) then that is used
// as a signal to cancel those translations.
// The popup connection is only used for state updates, such as model
// downloads and translation state. Since these are tab-specific but very
// frequent sending them over the connection instead of compat.runtime should
// keep some event loops a little less busy.
compat.runtime.onConnect.addListener((port) => {
    if (port.name == 'content-script')
        connectContentScript(port);
    else if (port.name.startsWith('popup-'))
        connectPopup(port);
});

// When a new tab is created start, track its active state
compat.tabs.onCreated.addListener(async ({id: tabId, openerTabId}) => {
    let inheritedState = {};

    // If the tab was opened from another tab that was already translating,
    // this tab will inherit that state and also automatically continue
    // translating.
    if (openerTabId) {
        inheritedState = await session.get(openerTabId).get({
            translate: false,
            url: undefined,
            from: undefined,
            to: undefined,
        });
    }

    session.get(tabId).set(inheritedState);
});

// Initialize or update the state of a tab when navigating
compat.tabs.onUpdated.addListener(async (tabId, diff, tab) => {
    if (diff.url) {
        const state = await session.get(tabId).get({
            translate: false,
            url: undefined
        });

        // If we changed domain, reset from, to and domain.
        if (!isSameDomain(diff.url, state.url)) {
            Object.assign(state, {
                translate: await isTranslatedDomain(diff.url),
                from: undefined,
                to: undefined
            });
        }

        session.get(tabId).set({
            ...state,
            url: diff.url
        });
    }

    if (diff.status && diff.status === 'complete') {
        const {translate, from, to} = await session.get(tabId).get({
            translate: false,
            from: undefined,
            to: undefined
        });

        if (translate && from && to) {
            compat.tabs.sendMessage(tabId, {
                command: 'TranslatePage',
                data: {from, to}
            });
        }
    }
    
    // TODO: treat reload and link different? Reload -> disable translation?
});

const handler = new MessageHandler(callback => {
    compat.runtime.onMessage.addListener(callback);
});

// Sent from content script once it has enough content to detect the language
handler.on('DetectLanguage', async (data, sender) => {
    // TODO: When we support multiple frames inside a tab, we
    // should integrate the results from each frame somehow.
    // For now we ignore it, because 90% of the time it will be
    // an ad that's in English and mess up our estimate.
    if (sender.frameId !== 0)
        return;

    try {
        const {preferredLanguageForPage:preferred} = await preferences.get({preferredLanguageForPage:undefined})
        const {from, to, models} = await detectLanguage(data, (await provider).registry, {preferred})
        session.get(sender.tab.id).set({from, to, models});

        // Should this page be translated?
        const {translate} = await session.get(sender.tab.id).get({translate: false});
        if (translate) {
            compat.tabs.sendMessage(sender.tab.id, {
                command: 'TranslatePage',
                data: {from, to}
            });
        }
    } catch (error) {
        console.error('Error during language detection', error);
        compat.runtime.sendMessage({
            command: 'Error',
            data: error
        });
    }
});

// Sent from the popup when the download button is clicked.
handler.on("DownloadModels", async ({tabId, from, to, models}) => {
    // Tell the tab we're downloading models
    /*
    tab.update(state => ({
        state: State.DOWNLOADING_MODELS
    }));
    */

    const translator = await provider;

    // Start the downloads and put them in a {[download:promise]: {read:int,size:int}}
    const downloads = new Map(models.map(model => [translator.downloadModel(model), {read:0.0, size:0.0}]));
    downloadProgress.set(tabId, downloads);

    // For each download promise, add a progress listener that updates the tab state
    // with how far all our downloads have progressed so far.
    downloads.forEach((_, promise) => {
        // (not supported by the Chrome offscreen proxy implementation right now)
        if (promise.addProgressListener) {
            promise.addProgressListener(async ({read, size}) => {
                // Update download we got a notification about
                downloads.set(promise, {read, size});

                // Update tab state about all downloads combined (i.e. model, optionally pivot)
                updatePopupDownloadProgress(tabId);
            });
        }

        promise.then(async () => {
            // Trigger update of state.models because the `local`
            // property this model has changed. We don't support
            // any nested key updates so let's just push the whole
            // damn thing.
            compat.runtime.sendMessage({
                command: 'Models',
                data: await translator.registry
            });
        })
    });

    // Finally, when all downloads have finished, start translating the page.
    try {
        await Promise.all(downloads.keys());
        
        downloadProgress.delete(tabId);
        updatePopupDownloadProgress(tabId);

        session.get(tabId).set({
            translate: true,
            from,
            to
        });

        compat.tabs.sendMessage(tabId, {
            command: 'TranslatePage',
            data: {from, to}
        });
    } catch (e) {
        compat.runtime.sendMessage({
            command: 'Error',
            data: e
        });
    }
});

// Sent from Popup when translate button is pressed
handler.on("TranslateStart", ({tabId, from, to}) => {
    session.get(tabId).set({
        translate: true,
        from,
        to
    });

    compat.tabs.sendMessage(tabId, {
        command: 'TranslatePage',
        data: {from, to}
    });
});

// Sent from Popup if "restore original page" button is pressed
handler.on('TranslateAbort', ({tabId}) => {
    session.get(tabId).set({translate: false});

    compat.tabs.sendMessage(tabId, {
        command: 'RestorePage',
        data: {}
    });
});

// Sent from popup when recorded pages download link is clicked
handler.on('ExportRecordedPages', ({}, sender, respond) => {
    respond({
        name: 'recorded-pages.xml',
        url: URL.createObjectURL(recorder.exportAXML())
    });
    recorder.clear();
    updateTab(state => ({recordedPagesCount: 0}));
    return true;
});

compat.runtime.onInstalled.addListener(() => {
    // Add "translate selection" menu item to selections
    compat.contextMenus.create({
        id: 'translate-selection',
        title: 'Translate Selection',
        contexts: ['selection']
    });

    // Add "type to translate" menu item to textareas
    compat.contextMenus.create({
        id: 'show-outbound-translation',
        title: 'Type to translate…',
        contexts: ['editable']
    });
});

compat.contextMenus.onClicked.addListener(async ({menuItemId, frameId}, tab) => {
    // First sanity check whether we know from and to languages
    // (and it isn't the same by accident)
    const {from, to} = await session.get(tab.id).get({from: undefined, to: undefined});

    // Send the appropriate message down to the content script of the
    // tab we just clicked inside of.
    switch (menuItemId) {
        case 'translate-selection':
            if (from === undefined || to === undefined || from === to)
                break; // Euh, what to do? Can't trigger a popup anymore

            compat.tabs.sendMessage(tab.id, {
                command: 'TranslateSelection',
                data: {from, to},
            }, {frameId});
            break;
        case 'show-outbound-translation':
            const translator = await provider;
            compat.tabs.sendMessage(tab.id, {
                command: 'ShowOutboundTranslation',
                data: {
                    from,
                    to,
                    models: await translator.registry
                },
            }, {frameId});
            break;
    }
})
