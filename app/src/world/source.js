// The cities' data as published (tools/deploy/publish.mjs). A file of a city lies in the bucket under a name of its
// own -- the hash of what is in it -- and the city's manifest says which name each file goes by: so a file is asked
// for by what it is (`overview.bin`, `tiles/b/19_26.bin`) and fetched from where it lies. cities.json says which cities
// there are. The dev server makes both lists up from what is on the disk.

// the channels a city is read through: the one on show, and what is published as next, to be looked at before it
// goes on show (?channel=next; tools/deploy/publish.mjs --channel next)
export const CHANNELS = ['manifest', 'next'];

// -> the city: its manifest (id, name, subtitle, tour, release, what the bake says of itself, ...) with
//    channel: which of the two it was read through; has(name): whether a file of that name is part of the city;
//    url(name): where it is fetched from
export async function openCity(origin, id, channel = CHANNELS[0]) {
  let response = await fetch(`${origin}/${id}/${channel}.json`);
  if (channel !== CHANNELS[0] && response.status === 404) {          // nothing is waiting as next: the one on show is read
    channel = CHANNELS[0];
    response = await fetch(`${origin}/${id}/${channel}.json`);
  }
  if (response.status === 404) throw new Error(`没有 ${id} 这座城`);
  if (!response.ok) throw new Error(`${id} 的清单取不到：${response.status}`);
  const manifest = await response.json(), files = manifest.files || {};
  return {
    ...manifest, id, channel,
    has: name => Object.hasOwn(files, name),
    url: name => {
      if (!Object.hasOwn(files, name)) throw new Error(`${id} 的数据里没有 ${name}`);
      return `${origin}/${id}/${files[name]}`;
    },
  };
}

// -> [{ id, name, subtitle, bounds, tour }]: the cities there are, for choosing one
export async function openCities(origin) {
  const response = await fetch(`${origin}/cities.json`);
  if (!response.ok) throw new Error(`城市的清单取不到：${response.status}`);
  return (await response.json()).cities;
}

// the city an address names: /hz -> hz; none for / or for anything that is not a city's address
export function cityAsked(pathname) {
  const match = pathname.match(/^\/([A-Za-z0-9_-]+)\/?$/);
  return match ? match[1] : '';
}
