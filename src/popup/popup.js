import compat from '../shared/compat.js';
import {
	addEventListeners,
	addBoundElementListeners,
	download,
  BoundElementRenderer,
  Timer,
  MessageHandler,
} from '../shared/common.js';
import preferences from '../shared/preferences.js';
import { StorageArea } from '../shared/storage.js';

const regionNamesInEnglish = new Intl.DisplayNames([...navigator.languages, 'en'], {type: 'language'});

function name(code) {
	if (!code)
		return undefined;
	
	try {
		return regionNamesInEnglish.of(code);
	} catch (RangeError) {
		return `[${code}]`; // fallback if code is not known or invalid
	}
};

const boundRenderer = new BoundElementRenderer(document.body);

async function main(tab) {
	const connection = compat.runtime.connect({name: `popup-${tab.id}`});

	const handler = new MessageHandler((callback) => {
		// Listen on our connection for local updates such as progress
		connection.onMessage.addListener(callback);

		// Listen on the runtime for global updates, such as the model list
		// and errors.
		compat.runtime.onMessage.addListener(callback);
	});

	const session = new StorageArea('session', `tab:${tab.id}`);

	const local = new StorageArea();

	// Browsing session state (i.e. since browser start)
	const tabState = session.view({
		translate: false,
		from: undefined,
		to: undefined,
		models: undefined,
		record: false,
		error: undefined,
	});

	// Plugin state (a synchronised view of what's currently in storage)
	const globalState = preferences.view({
		developer: false,
		alwaysTranslateDomains: [],
	})

	// Progress state (i.e. since last unload of background script)
	const localState = local.view({
		modelDownloadRead: 0,
    modelDownloadSize: 0,

    totalTranslationRequests: 0,
    pendingTranslationRequests: 0,
	});

	/**
	 * @type {Map<any,{
	 *   from:string,
	 *   to:string,
	 *   pivot:boolean,
	 *   models:number[]}
	 * }
	 */
	const models = new Map();

	// Sent during down downloading or translation from
	// the background-script.
	handler.on('Progress', (data) => {
		local.set(data);
	});

	// Sent as a response to connecting, but also when after downloading
	// the downloaded state of models change.
	handler.on('Models', (data) => {
		models.clear();
		data.forEach(entry => models.set(entry.model.id, entry));
	});

	let lastRenderedState = undefined;

	let renderTimeout = new Timer();

	function render() {
		console.log('Render popup', tabState, models);
		// If the model (or one of the models in case of pivoting) needs 
		// downloading. This info is not always entirely up-to-date since `local`
		// is a getter when queried from WASMTranslationHelper, but that doesn't
		// survive the message passing we use to get state.
		const modelsToDownload = models.size === 0 ? [] : tabState.models[0]
			?.models
			?.filter(id => !models.get(id).local)
			?.map(id => models.get(id).model.name);

		const renderState = {
			...globalState,
			...localState,
			...tabState,
			langFromName: name(tabState.from),
			langToName: name(tabState.to),
			langFromOptions: new Map(tabState.models.map(({from}) => [from, name(from)])),
			langToOptions: new Map(tabState.models.filter(model => tabState.from === model.from).map(({to, pivot}) => [to, name(to) + (pivot ? ` (via ${name(pivot)})` : '')])), // TODO doesn't this shadow direct models because just `to` is the key?
			needsDownload: modelsToDownload.length > 0,
			modelsToDownload,
			completedTranslationRequests: localState.totalTranslationRequests - localState.pendingTranslationRequests || undefined,
			canExportPages: tabState.recordedPagesCount > 0,
			domain: tabState.url && new URL(tabState.url).host,
			hasModelList: models.size > 0
		};

		// Little hack because we don't have a translation-completed state in the
		// background script, but we do want to render a different popup when there's
		// no more translations pending.
		// https://github.com/jelmervdl/translatelocally-web-ext/issues/54
		// if (renderState.state === 'translation-in-progress' && renderState.pendingTranslationRequests === 0)
		// 	renderState.state = 'translation-completed';

		// Callback to do the actual render
		const work = () => {
			// Remember the currently rendered state (for delay calculation below)
			lastRenderedState = renderState.state;
			boundRenderer.render(renderState);
		}

		// If we switched state, we delay the render a bit because we might be
		// flipping between two states e.g. a very brief translating-in-progress
		// because a new element popped up, and mostly translation-completed for the
		// rest of the time. We don't want that single brief element to make the
		// interface flicker between the two states all the time.
		if (tabState.state !== lastRenderedState && lastRenderedState !== undefined)
			renderTimeout.delayed(work, 250);
		else
			renderTimeout.immediate(work);
	}

	const areas = [globalState, tabState, localState];

	// re-render if the 'developer' preference changes (but also when the real
	// values are fetched from storage!)
	areas.forEach(area => area.addListener(render));

	addBoundElementListeners(document.body, (key, value) => {

		console.log('Setting', key, value);

		session.set({[key]: value});

		// If the user changes the 'translate to' field, interpret this as a
		// strong preference to always translate to that language.
		if (key === 'to')
			preferences.set({preferredLanguageForPage: value});
	});

	addEventListeners(document.body, {
		'click .translate-btn': e => {
			compat.runtime.sendMessage({
				command: 'TranslateStart',
				data: {
					tabId: tab.id,
					from: tabState.from,
					to: tabState.to
				}
			});
		},
		'click .download-btn': e => {
			const ids = tabState
				.models
				.find(({from, to}) => from === tabState.from && to === tabState.to)
				.models;

			if (!ids)
				throw new Error('Selected language pair that has no models');

			compat.runtime.sendMessage({
				command: 'DownloadModels',
				data: {
					tabId: tab.id,
					models: ids
				}
			});
		},
		'click .abort-translate-btn': e => {
			compat.runtime.sendMessage({
				command: 'TranslateAbort',
				data: {tabId: tab.id}
			});
		},
		'click .export-recorded-pages-btn': async e => {
			const data = await compat.runtime.sendMessage({
				command: 'ExportRecordedPages'
			});
			download(data.url, data.name);
		},
		'change #always-translate-domain-toggle': e => {
			const domain = new URL(tabState.url).host;
			preferences.set({alwaysTranslateDomains: e.target.checked
				? globalState.alwaysTranslateDomains.concat([domain])
				: globalState.alwaysTranslateDomains.filter(element => element !== domain)
			});
		}
	});
}

// Start!
compat.tabs.query({active: true, currentWindow: true}).then(tabs => main(tabs[0]));
