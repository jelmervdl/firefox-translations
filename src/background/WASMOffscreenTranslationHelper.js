import { PromiseWithProgress } from "../shared/promise";

export default class WASMOffscreenTranslationHelper {
    #connection;

    #initialized;

    #serial = 0;

    #pending = new Map();

    constructor(options) {
        this.#initialized = (async () => {
            const offscreenURL = chrome.runtime.getURL('offscreen.html');

            // Check if offscreen page is already available
            const matchedClients = await clients.matchAll();
            if (!matchedClients.some(client => client.url === offscreenURL)) {
                await chrome.offscreen.createDocument({
                    url: offscreenURL,
                    reasons: [chrome.offscreen.Reason.WORKERS],
                    justification: 'Translation engine'
                });
            }

            // Token we tell to offscreen so we know which connection request
            // was theirs.
            const token = crypto.randomUUID();

            // Ask offscreen to connect. It might already be running, so we
            // don't want to rely on a onLoad -> connect to background-page
            // type of construction.
            chrome.runtime.sendMessage({
                target: 'offscreen',
                command: 'Connect',
                data: {token}
            });

            // Catch offscreen's connect call
            this.#connection = await new Promise((accept) => {
                chrome.runtime.onConnect.addListener(function callback (port) {
                    if (port.name === token) {
                        accept(port);
                        chrome.runtime.onConnect.removeListener(callback);
                    }
                });
            });

            this.#connection.onMessage.addListener(({id, command, data}) => {
                const {accept, reject, progress} = this.#pending.get(id);
                switch (command) {
                    case 'Progress':
                        progress(data.progress);
                        return;  // Skip `clear(id)` bit.
                    case 'Accept':
                        accept(data.result);
                        break;
                    case 'Reject':
                        reject(data.error);
                        break;
                }
                this.#pending.delete(id);
            });

            // Re-initialise regardless (TODO: really?)
            await new Promise((accept, reject) => {
                this.#sendMessage({
                    command: 'Initialize',
                    data: {
                        args: [options]
                    },
                }, [accept, reject]);
            });

            return true;
        })();
    }

    #sendMessage(data, [accept, reject, progress]) {
        const id = ++this.#serial;
        this.#pending.set(id, {accept, reject, progress});
        this.#connection.postMessage({...data, id});
    }

    async #call(name, args, PromiseImpl=Promise) {
        return new PromiseImpl(async (...callbacks) => {
            await this.#initialized;
            this.#sendMessage({
                command: 'Call',
                data: {name, args}
            }, callbacks);
        })
    }

    #get(property) {
        return new Promise(async (...callbacks) => {
            await this.#initialized;
            this.#sendMessage({
                command: 'Get',
                data: {property}
            }, callbacks);
        });
    }

    get registry() {
        return this.#get('registry');
    }

    downloadModel(id) {
        return this.#call('downloadModel', [id], PromiseWithProgress); // normally returns PromiseWithProgress
    }

    translate(request) {
        return this.#call('translate', [request]);
    }

    remove(filter) {
        // Haha not implemented yet
    }

    delete() {
        if (this.#connection)
            this.#connection.disconnect();

        this.#initialized = null;
    }
}