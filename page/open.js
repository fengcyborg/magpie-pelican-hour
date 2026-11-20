magpie.ready.then(() => {
  const base = magpie.service || 'http://127.0.0.1:18765/';
  location.replace(new URL('?embedded=1', base).href);
});
