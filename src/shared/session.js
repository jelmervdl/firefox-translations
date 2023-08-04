import compat from './compat.js';

export async function setTabStorage(tabId, data) {
    const entries = Object.entries(data).map(([key, val]) => [`tab:${tabId}:${key}`, val]);
    await compat.storage.session.set(Object.fromEntries(entries));
}

export async function getTabStorage(tabId, keys) {
    const namespacedKeys = keys.map(key => `tab:${tabId}:${key}`);
    const response = await compat.storage.session.get(namespacedKeys);
    return Object.fromEntries(keys.map((key, i) => [key, response[namespacedKeys[i]]]));
}