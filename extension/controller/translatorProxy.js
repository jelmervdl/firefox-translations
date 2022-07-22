window.addEventListener('message', event => {
	// TODO: authenticate event to make sure it was sent by contentScript
	// and not some random page accessing this page because it is listed
	// in web_accessible_resources?

	const port = compat.runtime.connect(null, {name: 'translator-proxy'});

	const translator = new WASMTranslationHelper(event.options);

	makeServer(port, translator);

	port.onDisconnect.addListener(() => translator.delete());
}, false);
