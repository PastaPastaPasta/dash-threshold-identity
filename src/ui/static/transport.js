const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? sessionStorage.getItem('dti-token');
if (token) sessionStorage.setItem('dti-token', token);
history.replaceState(null, '', location.pathname);

export const platform = { hosted: false, networks: ['testnet', 'mainnet', 'local'], relayField: true, invite: null, inviteUrl: null };

export async function api(method, path, body) {
  if (!token) throw new Error('Open the URL that `dti ui` printed; it carries this session\'s token.');
  const url = method === 'GET' && body ? `${path}?${new URLSearchParams(body)}` : path;
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-dti-token': token }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}
