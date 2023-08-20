import compat from '../shared/compat.js';
import { MessageHandler } from '../shared/common.js';
import LanguageDetection from './LanguageDetection.js';
import InPageTranslation from './InPageTranslation.js';
import SelectionTranslation from './SelectionTranslation.js';
import OutboundTranslation from './OutboundTranslation.js';
import { LatencyOptimisedTranslator } from '@browsermt/bergamot-translator';
import preferences from '../shared/preferences.js';
import { lazy } from '../shared/func.js';

const listeners = new Map();

// Loading indicator for html element translation
preferences.bind('progressIndicator', progressIndicator => {
    document.body.setAttribute('x-bergamot-indicator', progressIndicator);
}, {default: ''})

preferences.bind('debug', debug => {
    if (debug)
        document.querySelector('html').setAttribute('x-bergamot-debug', true);
    else
        document.querySelector('html').removeAttribute('x-bergamot-debug');
}, {default: false});

const sessionID = new Date().getTime();

async function detectPageLanguage() {
    // request the language detection class to extract a page's snippet
    const languageDetection = new LanguageDetection();
    const sample = await languageDetection.extractPageContent();
    const suggested = languageDetection.extractSuggestedLanguages();

    // Once we have the snippet, send it to background script for analysis
    // and possibly further action (like showing the popup)
    compat.runtime.sendMessage({
        command: "DetectLanguage",
        data: {
            url: document.location.href,
            sample,
            suggested
        }
    });
}

// Changed by translation start requests.
const state = {
    from: null,
    to: null
};

// background-script connection is only used for translation
let connection = lazy(async (self) => {
    const port = compat.runtime.connect({name: 'content-script'});

    // Reset lazy connection instance if port gets disconnected
    port.onDisconnect.addListener(() => self.reset());

    // Likewise, if the connection is reset from outside, disconnect port.
    self.onReset(() => port.disconnect());

    const handler = new MessageHandler(callback => {
        port.onMessage.addListener(callback);
    })

    handler.on('TranslateResponse', data => {
        switch (data.request.user?.source) {
            case 'InPageTranslation':
                inPageTranslation.enqueueTranslationResponse(data);
                break;
            case 'SelectionTranslation':
                selectionTranslation.enqueueTranslationResponse(data);
                break;
        }
    });

    return port;
});

async function translate(text, user) {
    (await connection).postMessage({
        command: "TranslateRequest",
        data: {
            // translation request
            from: user.from || state.from,
            to: user.to || state.to,
            html: user.html,
            text,

            // data useful for the response
            user,
            
            // data useful for the scheduling
            priority: user.priority || 0,

            // data useful for recording
            session: {
                id: sessionID,
                url: document.location.href
            }
        }
    });
}

const inPageTranslation = new InPageTranslation({
    translate(text, user) {
        translate(text, {
            ...user,
            source: 'InPageTranslation'
        });
    }
});

const selectionTranslation = new SelectionTranslation({
    translate(text, user) {
        translate(text, {
            ...user,
            source: 'SelectionTranslation',
            priority: 3
        });
    }
});

const outboundTranslation = new OutboundTranslation(new class ErzatsTranslatorBacking {
    constructor() {
        // TranslatorBacking that is really just a proxy, but mimics just enough
        // for LatencyOptimisedTranslator to do its work.
        const backing = {
            async loadWorker() {
                // Pending translation promises.
                const pending = new Map();

                // Connection to the background script. Pretty close match to 
                // the one used in the global scope, but by having a separate
                // connection we can close either to cancel translations without
                // affecting the others.
                const connection = lazy(async (self) => {
                    const port = compat.runtime.connect({name: 'content-script'});

                    // Reset lazy connection instance if port gets disconnected
                    port.onDisconnect.addListener(() => self.reset());

                    // Likewise, if the connection is reset from outside, disconnect port.
                    self.onReset(() => port.disconnect());

                    const handler = new MessageHandler(callback => {
                        port.onMessage.addListener(callback);
                    })

                    handler.on('TranslateResponse', ({request: {user: {id}}, target, error}) => {
                        const {request, accept, reject} = pending.get(id);
                        pending.delete(id);

                        if (error)
                            reject(error)
                        else
                            accept([{request, target}]);
                    });

                    return port;
                });

                return {
                    // Mimics @browsermt/bergamot-translator/BergamotTranslatorWorker
                    exports: new class ErzatsBergamotTranslatorWorker {
                        /**
                         * Serial that provides a unique number for each translation request.
                         * @type {Number}
                         */
                        #serial = 0;

                        async hasTranslationModel({from, to}) {
                            return true;
                        }

                        async getTranslationModel({from, to}, options) {
                            throw new Error('getTranslationModel is not expected to be called');
                        }

                        translate({models, texts}) {
                            if (texts.length !== 1)
                                throw new TypeError('Only batches of 1 are expected');

                            return new Promise(async (accept, reject) => {
                                const request = {
                                    from: models[0].from,
                                    to:   models[models.length-1].to,
                                    html: texts[0].html,
                                    text: texts[0].text,
                                    user: {
                                        id: ++this.#serial
                                    },
                                    priority: 3
                                };

                                pending.set(request.user.id, {
                                    request,
                                    accept,
                                    reject
                                });

                                (await connection).postMessage({
                                    command: "TranslateRequest",
                                    data: request
                                });
                            })
                        }
                    },
                    worker: {
                        terminate() { 
                            connection.reset();
                            pending.clear();
                        }
                    }
                };
            },
            async getModels({from, to}) {
                return [{from,to}]
            }
        };

        // Separate translators for both directions so they have their own
        // queue. Using LatencyOptimisedTranslator to have it cancel all
        // translation requests that would otherwise clog up the queue. 
        const translator = new LatencyOptimisedTranslator({}, backing);
        this.translate = async (request) => {
            const response = await translator.translate(request)
            return response.target.text;
        };

        const backtranslator = new LatencyOptimisedTranslator({}, backing);
        this.backtranslate = async (request) => {
            const response = await backtranslator.translate(request)
            return response.target.text;
        }
    }

    onUserLanguageChange(language) {
        preferences.set('preferredLanguageForOutboundTranslation', language);
    }
}());

const handler = new MessageHandler(callback => {
    compat.runtime.onMessage.addListener(callback);
})

handler.on('TranslatePage', ({from,to}) => {
    // Save for the translate() function
    Object.assign(state, {from,to});

    inPageTranslation.addElement(document.querySelector("head > title"));
    inPageTranslation.addElement(document.body);
    inPageTranslation.start(from);
})

handler.on('RestorePage', () => {
    // Put original content back
    inPageTranslation.restore();

    // Close translator connection which will cancel pending translations.
    connection.reset();
})

detectPageLanguage();

// When this page shows up (either through onload or through history navigation)
window.addEventListener('pageshow', () => {
    // TODO: inPageTranslation.resume()???
});

// When this page disappears (either onunload, or through history navigation)
window.addEventListener('pagehide', e => {
    // Ditch the inPageTranslation state for pending translation requests.
    inPageTranslation.stop();
    
    // Disconnect from the background page, which will trigger it to prune
    // our outstanding translation requests.
    connection.reset();
});

let lastClickedElement = null;

window.addEventListener('contextmenu', e => {
    lastClickedElement = e.target;
}, {capture: true});

handler.on('TranslateSelection', ({from, to}) => {
    Object.assign(state, {from, to}); // TODO: HACK!
    const selection = document.getSelection();
    selectionTranslation.start(selection);
});

handler.on('ShowOutboundTranslation', async ({from, to, models}) => {
    if (from)
        outboundTranslation.setPageLanguage(from);

    const {preferredLanguageForOutboundTranslation} = await preferences.get({preferredLanguageForOutboundTranslation:undefined});
    if (to)
        outboundTranslation.setUserLanguage(preferredLanguageForOutboundTranslation || to);

    if (from || models) {
        outboundTranslation.setUserLanguageOptions(models.reduce((options, entry) => {
            // `state` has already been updated at this point as well and we know
            // that is complete. `diff` might not contain all the keys we need.
            if (entry.to === from && !options.has(entry.from))
                options.add(entry.from)
            return options
        }, new Set()));
    }

    outboundTranslation.target = lastClickedElement;
    outboundTranslation.start();
});
