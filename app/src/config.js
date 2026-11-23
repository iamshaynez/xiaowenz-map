// Where the cities' data comes from: a bucket of baked files under a name of its own (deploy/README.md), read through
// two lists -- which cities there are (cities.json) and which files make up a city (<city>/manifest.json; the layout
// is tools/deploy/manifest.mjs's). This is the one place that says where.
//
// Locally the dev server stands in for the bucket on a second port (serve.mjs), so that the page is cross-origin here
// as it is online. The second line of DATA_ORIGIN is what a domain of your own changes.
const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
export const DATA_ORIGIN = local ? `${location.protocol}//${location.hostname}:${(Number(location.port) || 5300) + 100}` : 'https://data-city.xiaowenz.com';
