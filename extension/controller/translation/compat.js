class NotImplementedError extends Error {
	constructor() {
		super('Not implemented');
	}
}

function promisify(object, methods) {
	return new Proxy(object, {
		get(target, prop, receiver) {
			// Note: I tried using Reflect.get() here, but Chrome doesn't like that.
			if (methods.includes(prop))
				return (...args) => new Promise(accept => target[prop](...args, accept));
			else
				return target[prop];
		}
	});
}

const compat = new class {
	#isFirefox = false;
	#isChromiumV2 = false;
	#runtime;

	constructor() {
		if (typeof browser !== 'undefined') {
			this.#runtime = browser;
			this.#isFirefox = true;
		} else if (typeof chrome !== 'undefined') {
			this.#runtime = chrome;
			this.#isChromiumV2 = chrome.runtime.getManifest().manifest_version === 2;
		} else {
			throw new NotImplementedError();
		}
	}

	get storage() {
		if (this.#isChromiumV2)
			return new Proxy(chrome.storage, {
				get(target, prop, receiver) {
					if (['sync', 'local', 'managed'].includes(prop))
						return promisify(chrome.storage[prop], ['get', 'set']);
					else
						return chrome.storage[prop]
				}
			});
		else
			return this.#runtime.storage;
	}

	get runtime() {
		return this.#runtime.runtime;
	}

	get webNavigation() {
		return this.#runtime.webNavigation;
	}

	get tabs() {
		if (this.#isChromiumV2)
			return promisify(chrome.tabs, ['query']);
		else
			return this.#runtime.tabs;
	}

	get i18n() {
		if (this.#isChromiumV2)
			return promisify(chrome.i18n, ['detectLanguage', 'getAcceptLanguages']);
		else
			return this.#runtime.i18n;
	}

	get action() {
		if (this.#isFirefox || this.#isChromiumV2)
			return this.#runtime.browserAction;
		else
			return this.#runtime.action;
	}
};