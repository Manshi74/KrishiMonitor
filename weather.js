import { URL } from 'node:url';

const API_HOST = 'https://weather.visualcrossing.com';
const API_PATH = '/VisualCrossingWebServices/rest/services/timeline/';
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();
const coordinateTimelines = new Map();

function configured() { return Boolean(process.env.VISUAL_CROSSING_API_KEY); }
function requireKey() {
  if (!configured()) throw Object.assign(new Error('Weather service is not configured. Set VISUAL_CROSSING_API_KEY on the backend.'), { status: 503 });
}
function cached(key, getter) {
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && entry.expires > now) return entry.value;
  const promise = getter();
  cache.set(key, { value: promise, expires: now + CACHE_MS });
  if (cache.size > 200) for (const [cacheKey, item] of cache) if (item.expires <= now) cache.delete(cacheKey);
  return promise.catch(error => { cache.delete(key); throw error; });
}
async function getTimeline(location, parameters = {}, dateRange = '') {
  requireKey();
  const rangePath = dateRange ? `/${dateRange}` : '';
  const url = new URL(`${API_PATH}${encodeURIComponent(location)}${rangePath}`, API_HOST);
  for (const [key, value] of Object.entries({ unitGroup: 'metric', contentType: 'json', ...parameters, key: process.env.VISUAL_CROSSING_API_KEY })) {
    url.searchParams.set(key, String(value));
  }
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } }); }
  catch (error) {
    throw Object.assign(new Error(error.name === 'TimeoutError' ? 'Visual Crossing timed out. Try again.' : 'Visual Crossing is unreachable. Try again.'), { status: 503 });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status === 404 ? 404 : response.status === 400 ? 400 : response.status === 401 || response.status === 403 ? 502 : response.status === 429 ? 503 : 502;
    const message = response.status === 404 ? 'No weather location was found.'
      : response.status === 400 ? 'Visual Crossing could not process this weather request.'
        : response.status === 401 || response.status === 403 ? 'Visual Crossing rejected the server API key or the account does not have access to this data.'
          : response.status === 429 ? 'Visual Crossing request limit reached. Try again later.'
            : 'Visual Crossing could not complete the request.';
    throw Object.assign(new Error(message), { status });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('Visual Crossing returned an invalid response.'), { status: 502 });
  return data;
}
function validateCoordinates(latValue, lonValue) {
  const lat = Number(latValue), lon = Number(lonValue);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw Object.assign(new Error('Enter valid latitude and longitude coordinates.'), { status: 400 });
  }
  return { lat, lon };
}
function cacheKey(prefix, lat, lon, language, label) { return `${prefix}:${lat.toFixed(3)}:${lon.toFixed(3)}:${language}:${String(label).slice(0, 100)}`; }
function asNumber(value) { const number = Number(value); return value !== null && value !== undefined && Number.isFinite(number) ? number : null; }
function timelineLocation(lat, lon) { return `${lat},${lon}`; }
function coordinateKey(lat, lon) { return `${lat.toFixed(3)}:${lon.toFixed(3)}`; }
function rememberTimeline(lat, lon, data) {
  const key = coordinateKey(lat, lon);
  coordinateTimelines.set(key, { value: data, expires: Date.now() + CACHE_MS });
  if (coordinateTimelines.size > 200) for (const [itemKey, item] of coordinateTimelines) if (item.expires <= Date.now()) coordinateTimelines.delete(itemKey);
}
function timelineForCoordinates(lat, lon) {
  const key = coordinateKey(lat, lon);
  const existing = coordinateTimelines.get(key);
  if (existing && existing.expires > Date.now()) return Promise.resolve(existing.value);
  const pending = getTimeline(timelineLocation(lat, lon), { include: 'current,days' });
  coordinateTimelines.set(key, { value: pending, expires: Date.now() + CACHE_MS });
  return pending.then(data => { rememberTimeline(lat, lon, data); return data; }, error => { coordinateTimelines.delete(key); throw error; });
}
function validateHistoryDates(fromValue, toValue) {
  const from = String(fromValue || ''), to = String(toValue || '');
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!validDate(from) || !validDate(to) || from > to) throw Object.assign(new Error('Choose a valid historical date range.'), { status: 400 });
  const today = new Date().toISOString().slice(0, 10);
  if (to >= today) throw Object.assign(new Error('Historical weather dates must be before today.'), { status: 400 });
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days > 31) throw Object.assign(new Error('Historical weather is limited to 31 days per request.'), { status: 400 });
  return { from, to };
}

export const weatherService = {
  get configured() { return configured(); },
  async locations(query) {
    requireKey();
    const q = String(query || '').trim();
    if (q.length < 2 || q.length > 100) throw Object.assign(new Error('Location search must be 2 to 100 characters.'), { status: 400 });
    return cached(`location:${q.toLowerCase()}`, async () => {
      // Timeline accepts place names and coordinates, then returns its resolved location.
      const data = await getTimeline(q, { include: 'current,days' });
      const lat = asNumber(data.latitude), lon = asNumber(data.longitude);
      if (lat === null || lon === null) throw Object.assign(new Error('Visual Crossing could not resolve that location.'), { status: 404 });
      rememberTimeline(lat, lon, data);
      return [{ name: String(data.resolvedAddress || q).slice(0, 180), state: '', country: '', lat, lon }];
    });
  },
  async current(latValue, lonValue, language = 'en', label = '') {
    const { lat, lon } = validateCoordinates(latValue, lonValue);
    const lang = 'en'; // Visual Crossing does not list Hindi among its supported response languages.
    const key = cacheKey('current', lat, lon, lang, label);
    return cached(key, async () => {
      const data = await timelineForCoordinates(lat, lon);
      const current = data.currentConditions || {};
      const epoch = asNumber(current.datetimeEpoch);
      const observedAt = epoch === null ? null : new Date(epoch * 1000).toISOString();
      const stale = !observedAt || Date.now() - epoch * 1000 > 3 * 60 * 60 * 1000 || epoch * 1000 - Date.now() > 10 * 60 * 1000;
      const windKmh = asNumber(current.windspeed);
      const rain = asNumber(current.precip);
      return {
        location: String(data.resolvedAddress || label || ''), latitude: lat, longitude: lon,
        temperature: !stale ? asNumber(current.temp) : null,
        feelsLike: !stale ? asNumber(current.feelslike) : null,
        humidity: !stale ? asNumber(current.humidity) : null,
        rainfallMm: !stale ? rain : null,
        rainfallPeriod: !stale && rain !== null ? 'current' : null,
        windSpeedMs: !stale && windKmh !== null ? Number((windKmh / 3.6).toFixed(1)) : null,
        windDirectionDegrees: !stale ? asNumber(current.winddir) : null,
        summary: stale ? '' : String(current.conditions || ''),
        conditionCode: null, observedAt, stale,
        timezoneOffsetSeconds: (asNumber(data.tzoffset) || 0) * 3600,
        source: 'Visual Crossing Timeline Weather API'
      };
    });
  },
  async forecast(latValue, lonValue, language = 'en', label = '') {
    const { lat, lon } = validateCoordinates(latValue, lonValue);
    const lang = 'en';
    const key = cacheKey('forecast', lat, lon, lang, label);
    return cached(key, async () => {
      const data = await timelineForCoordinates(lat, lon);
      if (!Array.isArray(data.days)) throw Object.assign(new Error('Visual Crossing returned an invalid forecast.'), { status: 502 });
      return {
        location: String(data.resolvedAddress || label || ''),
        source: 'Visual Crossing Timeline Weather API',
        updatedAt: new Date().toISOString(),
        days: data.days.filter(day => typeof day.datetime === 'string').slice(0, 5).map(day => ({
          date: day.datetime.slice(0, 10), minTemperature: asNumber(day.tempmin), maxTemperature: asNumber(day.tempmax),
          rainfallMm: asNumber(day.precip), precipitationProbability: asNumber(day.precipprob),
          summary: String(day.conditions || ''), conditionCode: null
        }))
      };
    });
  },
  async history(latValue, lonValue, fromValue, toValue, language = 'en', label = '') {
    const { lat, lon } = validateCoordinates(latValue, lonValue);
    const { from, to } = validateHistoryDates(fromValue, toValue);
    const lang = 'en';
    const key = `${cacheKey('history', lat, lon, lang, label)}:${from}:${to}`;
    return cached(key, async () => {
      const location = timelineLocation(lat, lon);
      const data = await getTimeline(location, { include: 'days', lang }, `${from}/${to}`);
      if (!Array.isArray(data.days)) throw Object.assign(new Error('Visual Crossing returned invalid historical data.'), { status: 502 });
      return {
        location: String(data.resolvedAddress || label || ''), source: 'Visual Crossing Timeline Weather API', from, to,
        days: data.days.map(day => ({ date: String(day.datetime || '').slice(0, 10), minTemperature: asNumber(day.tempmin), maxTemperature: asNumber(day.tempmax), rainfallMm: asNumber(day.precip), humidity: asNumber(day.humidity), summary: String(day.conditions || '') }))
      };
    });
  }
};
