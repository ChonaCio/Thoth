// Ad, pop-under and tracking networks: what the source wizard's preview and the headless browser that builds pages
// (render.js) don't load. A host matches when it is one of these or ends in "." + one of these. Pop-ups and
// redirects are blocked whatever their address (see the wizard's preview and render.js); this list is for the ads
// themselves and the scripts that open them.
const AD_HOSTS = [
  // display and programmatic ads
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'googletagservices.com',
  'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'pubmatic.com', 'rubiconproject.com', 'openx.net',
  'casalemedia.com', 'moatads.com', 'adform.net', 'smartadserver.com', '33across.com', 'media.net', 'bidvertiser.com',
  'infolinks.com', 'taboola.com', 'outbrain.com', 'mgid.com', 'revcontent.com', 'adskeeper.com', 'adskeeper.co.uk',
  'yandex-adv.ru', 'an.yandex.ru',
  // pop-unders, redirects and click hijacks
  'popads.net', 'popcash.net', 'propellerads.com', 'propellerclick.com', 'onclickads.net', 'onclkds.com',
  'exoclick.com', 'exosrv.com', 'juicyads.com', 'trafficjunky.net', 'trafficstars.com', 'tsyndicate.com',
  'hilltopads.net', 'adcash.com', 'a-ads.com', 'clickadu.com', 'clickaine.com', 'galaksion.com', 'monetag.com',
  'admaven.com', 'ad-maven.com', 'adsterra.com', 'highperformanceformat.com', 'zeropark.com', 'popmyads.com',
  'clickadilla.com', 'pushground.com', 'richads.com', 'evadav.com', 'adspyglass.com', 'aclib.net',
  // trackers that come with them
  'scorecardresearch.com', 'quantserve.com', 'adsrvr.org', 'bidswitch.net', 'everesttech.net'
];

function isAdHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return AD_HOSTS.some(d => h === d || h.endsWith('.' + d));
}

module.exports = { AD_HOSTS, isAdHost };
