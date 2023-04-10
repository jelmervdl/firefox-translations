import {BoundElementRenderer, addBoundElementListeners} from '../shared/common.js';
import { LatencyOptimisedTranslator, SupersededError } from '@browsermt/bergamot-translator';
import compat from '../shared/compat.js';

let backgroundScript;

const listeners = new Map();

const state = {
	from: '',
	to: '',
	models: []
};

function on(command, callback) {
	if (!listeners.has(command))
		listeners.set(command, []);

	listeners.get(command).push(callback);
}

function connectToBackgroundScript() {
	// If we're already connected (e.g. when this function was called directly
	// but then also through 'pageshow' event caused by 'onload') ignore it.
	if (backgroundScript)
		return;

	// Connect to our background script, telling it we're the content-script.
	backgroundScript = compat.runtime.connect({name: 'sidebar'});

	// Connect all message listeners (the "on()" calls above)
	backgroundScript.onMessage.addListener(({command, data}) => {
		if (listeners.has(command))
			listeners.get(command).forEach(callback => callback(data));
	});
}

const regionNamesInEnglish = new Intl.DisplayNames([...navigator.languages, 'en'], {type: 'language'});

const boundRenderer = new BoundElementRenderer(document.body);

function render() {
	const name = (code) => {
		if (!code)
			return undefined;
		
		try {
			return regionNamesInEnglish.of(code);
		} catch (RangeError) {
			return `[${code}]`; // fallback if code is not known or invalid
		}
	};

	const renderState = {
		'langFromName': name(state.from),
		'langToName': name(state.to),
		'langFromOptions': new Map(state.models?.map(({from}) => [from, name(from)])),
		'langToOptions': new Map(state.models?.filter(model => state.from === model.from).map(({to, pivot}) => [to, name(to) + (pivot ? ` (via ${name(pivot)})` : '')])),
	};

	boundRenderer.render(renderState);
}

addBoundElementListeners(document.body, (key, value) => {
	backgroundScript.postMessage({
		command: 'UpdateRequest',
		data: {[key]: value}
	});
});

on('Update', data => {
	if ('from' in data)
		state.from = data.from;

	if ('to' in data)
		state.to = data.to;

	if ('models' in data)
		state.models = data.models;

	render();
});

connectToBackgroundScript();

const translationWorker = new class {
	#serial = 0;

	#pending = new Map();
	
	async hasTranslationModel({from, to}) {
		return true;
	}

	async getTranslationModel({from, to}, options) {
		throw new Error('getTranslationModel is not expected to be called');
	}

	translate({models, texts}) {
		if (texts.length !== 1)
			throw new TypeError('Only batches of 1 are expected');

		return new Promise((accept, reject) => {
			const request = {
				// translation request
				from: models[0].from,
				to: models[0].to,
				html: texts[0].html,
				text: texts[0].text,

				// data useful for the response
				user: {
					id: ++this.#serial,
					source: 'Sidebar'
				},
				
				// data useful for the scheduling
				priority: 3,

				// data useful for recording
				session: {}
			};

			this.#pending.set(request.user.id, {request, accept, reject});
			backgroundScript.postMessage({
				command: "TranslateRequest",
				data: request
			});
		})
	}

	enqueueTranslationResponse({request: {user: {id}}, target, error}) {
		const {request, accept, reject} = this.#pending.get(id);
		this.#pending.delete(id);
		if (error)
			reject(error)
		else
			accept([{request, target}]);
	}
}

on('TranslateResponse', data => {
    switch (data.request.user?.source) {
        case 'Sidebar':
            translationWorker.enqueueTranslationResponse(data);
            break;
    }
});

const translator = new LatencyOptimisedTranslator({}, {
	async loadWorker() {
		return {
			exports: translationWorker,
			worker: {
				terminate() { return; }
			}
		};
	},
	async getModels({from, to}) {
		return [{from,to}]
	}
});

async function translate() {
	try {
		const response = await translator.translate({
			from: document.getElementById('lang-from').value,
			to: document.getElementById('lang-to').value,
			text: document.getElementById('input').value,
		});
		document.getElementById('output').value = response.target.text;
	} catch (err) {
		if (err instanceof SupersededError)
			return;
		throw err;
	}
}

document.getElementById('input').addEventListener('input', translate);
