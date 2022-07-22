/**
 * Little wrapper to delay a promise to be made only once it is first awaited on
 */
function lazy(factory) {
    let promise = null;

    return new class {
        then(...args) {
            // Ask for the actual promise
            if (promise === null) {
                promise = factory();

                if (typeof promise?.then !== 'function')
                    throw new TypeError('factory() did not return a promise-like object');
            }

            // Forward the current call to the promise
            return promise.then(...args);
        }

        get resolved() {
            return promise !== null;
        }
    };
}

/**
 * Array.prototype.map, but with a twist: the functor returns an iterator
 * (or more usefully) a generator, it will then add each of those elements.
 */
function *flatten(iterable, functor) {
    for (let item of iterable)
        yield* functor(item);
}

/**
 * `product([a,b], [1,2]) == [[a,1], [a,2], [b,1], [b,2]]`
 */
function* product(as, bs) {
    for (let a of as)
        for (let b of bs)
            yield [a, b];
}

/**
 * Take the first element from anything that can be iterated over. Like arr[0]
 * or iterable[Symbol.iterator].next().value. If the iterator is empty, throw.
 */
function first(iterable) {
    for (let item of iterable)
        return item;
    throw new RangeError('Iterable is empty');
}

/**
 * Returns a set that is the intersection of two iterables
 */
function intersect(a, b) {
    const bSet = new Set(b);
    return new Set(Array.from(a).filter(item => bSet.has(item)));
}

/**
 * Converts the hexadecimal hashes from the registry to something we can use with
 * the fetch() method.
 */
function hexToBase64(hexstring) {
    return btoa(hexstring.match(/\w{2}/g).map(function(a) {
        return String.fromCharCode(parseInt(a, 16));
    }).join(""));
}

/**
 * Turns a port into a proxy object that calls an object on the other side
 * of the port. All proxied methods return promises. On the other side of the
 * port use `makeServer()`.
 * @param {Port | MessagePort} port
 * @return {{[method:string]: (...any) => Promise<any>}}
 */
function makeClient(port) {
    let serial = 0;

    let pending = new Map();

    function call(name, args) {
        return new Promise((accept, reject) => {
            const id = ++serial;
            pending.set(id, {accept, reject});
            port.postMessage({id, name, args});
        });
    }

    function receive({id, result, error}) {
        if (!pending.has(id)) {
            console.debug('Received message with unknown id:', arguments[0]);
            throw new Error(`Client received response to unknown call '${id}'`);
        }

        const {accept, reject} = pending.get(id);

        if (error !== undefined)
            reject(Object.assign(new Error(), error));
        else
            accept(result);
    }

    if (port.onMessage)
        port.onMessage.addListener(receive);
    else if (port.addEventListener)
        port.addEventListener('message', event => receive(event.data));
    else
        throw new TypeError('Unknown port type');

    return new Proxy({}, {
        get(target, name, receiver) {
            // Make this work with Promise.resolve() by making sure
            // the proxy is not 'then-able'.
            if (name === 'then')
                return undefined;

            return (...args) => call(name, Array.from(args));
        }
    });
}

/**
 * Exposes all methods of `delegate` to any client made using `makeClient` on
 * the port.
 * @param {Port | MessagePort} port
 * @param {{[method:string]: (...any) => any}} delegate
 */
function makeServer(port, delegate) {
    async function receive({id, name, args}) {
        if (!id) {
            console.debug('Message without id:', arguments[0]);
            throw new Error('Received message without id');
        }

        try {
            if (typeof delegate[name] !== 'function')
                throw TypeError(`delegate[${name}] is not a function`);

            // Using `Promise.resolve` to await any promises that delegate[name]
            // possibly returns.
            const result = await Promise.resolve(Reflect.apply(delegate[name], delegate, args));
            port.postMessage({id, result});
        } catch (error) {
            port.postMessage({
                id,
                error: {
                    name: error.name,
                    message: error.message,
                    fileName: error.fileName,
                    lineNumber: error.lineNumber,
                    columnNumber: error.columnNumber
                }
            })
        }
    }

    if (port.onMessage)
        port.onMessage.addListener(receive);
    else if (port.addEventListener)
        port.addEventListener('message', event => receive(event.data));
    else
        throw new TypeError('Unknown port type');
}
