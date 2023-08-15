/**
 * Promise class, but with a progress notification. Useful for things like
 * downloads where there is information about progress.
 */
export class PromiseWithProgress extends Promise {
    #listeners;

    constructor(factory) {
        super((accept, reject) => {
            try {
                factory(
                    (...args) => {
                        // Clean up listeners when promise finishes.
                        this.#listeners.clear();
                        accept(...args);
                    },
                    (...args) => {
                        this.#listeners.clear();
                        reject(...args);
                    },
                    (progress) => {
                        this.#listeners.forEach(listener => listener(progress));
                    });
            } catch (err) {
                this.#listeners.clear();
                throw err;
            }
        });

        // Keep list of progress listeners
        this.#listeners = new Set();
    }

    addProgressListener(callback) {
        this.#listeners.add(callback);
    }
}
