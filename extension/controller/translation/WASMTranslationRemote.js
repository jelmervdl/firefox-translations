/**
 * Two-way remote RPC shim. Other side can call anything on delegate. This can
 * call anything on other side's delegate using `call()` or `obj.remote`.
 */
class TwoWayChannel {
	constructor(port, delegate) {
		this.port = port;
		this.port.onmessage = this.onMessage.bind(this);
		this.delegate = delegate;
		this.pending = new Map();
		this.serial = 0;

		this.remote = new Proxy({}, {
			get(target, name, receiver) {
				return (...args) => this.call(name, Array.from(args))
			}
		});
	}

	onMessage(message) {
		switch (message.command) {
			case "Call":
				this.onCall(message.data);
				break;
			case "Return":
				this.onReturn(message.data);
				break;
		}
	}

	onCall({id, name, args}) {
		new Promise(Reflect.apply(this.delegate[name], args)).then(message => {
			this.port.postMessage({
				command: "Return",
				data: {id, message}
			});
		}).catch(error => {
			this.port.postMessage({
				command: "Return",
				data: {id, error}
			})
		});
	}

	onReturn({id, message, error}) {
		const {accept, reject} = this.pending.get(id);
		if (error !== undefined)
			reject(error);
		else
			accept(message);
	}

	call(name, args) {
		return new Promise((accept, reject) => {
			const id = ++this.serial;

			this.pending.set(id, {accept, reject});

			this.port.postMessage({
				command: "Call",
				data: {id, name, args}
			});
		});
	}
}


class WASMTranslationSender {
	constructor(port, options) {
		
		// Have that one local at least. Is cheaper.
		this.registry = new WASMTranslationHelper().registry;

		this.channel = new TwoWayChannel(port, {
			getOptions() {
				return options;
			}
		});

		this.options = options;
	}
	
	translate(request) {
		return this.channel.call('translate', [request]);
	}

	remove(pred) {
		// It is very likely that the translations we're trying to remove are
		// from the frame that was running the receiver anyway.
		return;
	}
}

class WASMTranslationReceiver {
	constructor(port) {
		this.translator = null;

		this.port = new TwoWayChannel(port, {
			async translate(request) {
				if (!this.translator)
					this.translator = new WASMTranslationHelper(await this.port.remote.getOptions());

				return this.translator.translate(request);
			}
		});
	}
}