import WASMTranslationHelper from "./WASMTranslationHelper.js";
import { PromiseWithProgress } from "../shared/promise.js";
import { MessageHandler } from "../shared/common.js";

let helper = null;

function cloneError(error) {
	return {
		name: error.name,
		message: error.message,
		stack: error.stack
	};
}

chrome.runtime.onMessage.addListener((message, sender) => {
	if (message.target !== 'offscreen')
		return false;

	if (message.command === 'Connect' && message.data?.token !== undefined) {
		const port = chrome.runtime.connect({name: message.data.token});

		const context = {
			helper: undefined
		};

		port.onDisconnect.addListener(() => {
			if (context.helper)
				context.helper.delete();
		});

		port.onMessage.addListener(({id, command, data}) => {
			const waitAndRespond = (promise) => {
				if (promise instanceof PromiseWithProgress) {
					promise.addProgressListener(progress => {
						port.postMessage({
							command: 'Progress',
							id,
							data: {progress}
						});
					});
				}
				Promise.resolve(promise).then(
					result => {
						port.postMessage({
							command: 'Accept',
							id,
							data: {result}
						})
					},
					error => {
						port.postMessage({
							command: 'Reject',
							id,
							data: {error: cloneError(error)}
						})
					}
				);
			}

			switch (command) {
				case 'Initialize':
					waitAndRespond((async () => {
						console.log('Initialize');

						if (context.helper)
							await context.helper.delete();

						context.helper = new WASMTranslationHelper(...data.args);
						console.log('Initialized');
						return undefined;
					})());
					break;

				case 'Get':
					console.log('Get', data.property);
					waitAndRespond(Reflect.get(context.helper, data.property, context.helper));
					break;

				case 'Call':
					console.log('Call', message.data.name);
					waitAndRespond(Reflect.apply(context.helper[data.name], context.helper, data.args));
					break;
			}
		});
	}
});
