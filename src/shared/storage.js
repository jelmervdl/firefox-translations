import compat from './compat.js';

class MemoryBacking {
    #data;

    constructor(data) {
        this.#data = data || {};
    }

    async get(keys) {
        if (keys)
            return Object.fromEntries(keys.map(key => [key, this.#data[key]]));
        else
            return Object.assign({}, this.#data);
    }

    async set(data) {
        return Object.assign(this.#data, data);
    }

    async remove(key) {
        delete this.#data[key];
    }

    get onChanged() {
        return {
            addListener(callback) {
                // do nothing
            },
            removeListener(callback) {
                // do even less
            }
        }
    }
}

export class StorageArea {
    #backing;

    #namespace;

    #listeners;

    /**
     * @param {String|{[key:String]:any}|Null} area
     * @param {String?} namespace;
     */
    constructor(area, namespace) {
        this.#backing = typeof area === 'string'
            ? compat.storage[area]
            : new MemoryBacking(area);
        this.#namespace = namespace ? `${namespace}:` : '';
        this.#listeners = new Set();
    }
    /**
     * Get preference from storage, or return `fallback` if there was no
     * preference.
     * @param {{[key:String]:any}} defaults
     * @return {Promise<{[key:String]:any}>}
     */
    async get(defaults) {
        let keys, fullKeys, response;

        if (defaults) {
            keys = Object.keys(defaults);
            fullKeys = keys.map(key => this.#namespace + key);
            response = await this.#backing.get(fullKeys);
        } else {
            response = await this.#backing.get();
            fullKeys = Object.keys(response);
            keys = fullKeys
                .filter(fullKey => fullKey.startsWith(this.#namespace))
                .map(fullKey => fullKey.slice(this.#namespace.length));
        }

        return Object.fromEntries(keys.map((key, i) => {
            if (response[fullKeys[i]] !== undefined)
                return [key, response[fullKeys[i]]];
            else
                return [key, defaults[key]];
        }));
    }

    /**
     * Changes preferences. Will notify other pages about the change.
     * @param {{[key:String]:any}} entries
     * @param {{silent:Boolean}?} options
     */
    async set(data, options) {
        const fullData = Object.fromEntries(Object.entries(data).map(([key, value]) => [this.#namespace + key, value]));
        await this.#backing.set(fullData);
        
        // Emulate the onChanged event storage normally sends to global listeners
        // but to our local listeners
        if (!options?.silent) {
            const diff = Object.fromEntries(Object.entries(data).map(([key, value]) => [this.#namespace + key, {newValue:value}]));
            this.#listeners.forEach(callback => callback(diff));
        }
    }

    /**
     * Deletes key from storage. `get(key)` will return fallback value afterwards
     * @param {String} key
     */
    async remove(key) {
        return await this.#backing.remove(this.#namespace + key);
    }

    /**
     * Listen to preference changes.
     * @param {String[]} keys
     * @param {({[key:String]:Any}) => undefined} callback
     * @return {() => null} callback to stop listening
     */
    listen(keys, callback) {
        const fullKeys = keys.map(key => this.#namespace + key);

        const listener = (changes) => {
            // Select only the keys that we're listening for
            const relevant = Object.keys(changes).filter(key => {
                return fullKeys.includes(key);
            });

            if (relevant.length === 0)
                return;

            // Create a {[key]:val} object with only the changes
            // for the keys we're listening for
            const diff = Object.fromEntries(relevant.map(fullKey => [
                fullKey.slice(this.#namespace.length),
                changes[fullKey].newValue
            ]));

            callback(diff);
        };

        // Global events
        this.#backing.onChanged.addListener(listener);

        // Local events
        this.#listeners.add(listener);

        return () => {
            this.#backing.onChanged.removeListener(listener);
            this.#listeners.delete(listener);
        };
    }

    /**
     * get() + listen() in an easy package.
     * @param {String} key
     * @param {(Object) => null} callback called with value and when value changes
     * @return {() => null} callback to stop listening
     */
    bind(key, callback, options) {
        this.get({[key]: options?.default}).then(response => callback(response[key]));
        return this.listen([key], diff => callback(diff[key]));
    }

    /**
     * Create a (not async) view of the preferences that's faster to access
     * frequently. Will be kept in sync. Use addListener() to know when it
     * changes.
     */
    view(defaults) {
        const listeners = new Set();

        // Our returned view prototype
        const view = Object.create({
            addListener(callback) {
                listeners.add(callback);
            },
            delete: () => {
                stopListening();
            }
        });

        Object.assign(view, defaults);

        const callback = (changes) => {
            const diff = {};

            for (const key in changes) {
                if (changes[key] !== view[key])
                    diff[key] = changes[key];
            }

            if (Object.keys(diff).length === 0)
                return;

            Object.assign(view, diff);
            listeners.forEach(listener => listener(diff));
        };

        // Listen for changes to any of these keys
        var stopListening = this.listen(Object.keys(defaults), callback);

        // Get their initial value from storage
        this.get(defaults).then(callback);

        return new Proxy(view, {
            get(...args) {
                return Reflect.get(...args)
            },

            set(...args) {
                throw new Error('Preference view is read-only')
            }
        });
    }
};
