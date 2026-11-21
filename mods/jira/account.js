const NO_ACCOUNT_EXIT = 3;
const NO_TOKEN_EXIT = 3;

const PROFILE_FILE_TOKEN = `[ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null; [ -n "$ATLASSIAN_API_KEY" ] || exit ${NO_TOKEN_EXIT}; printf %s "$ATLASSIAN_API_KEY"`;
const TOKEN_HELP = "make one at https://id.atlassian.com/manage-profile/security/api-tokens";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function utf8Bytes(text) {
  const bytes = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return bytes;
}

export function base64(text) {
  const bytes = utf8Bytes(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]
      + (b === undefined ? "=" : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)])
      + (c === undefined ? "=" : ALPHABET[c & 63]);
  }
  return out;
}

const signedIn = (site, email, token, from) => ({ site, email, authorization: `Basic ${base64(`${email}:${token}`)}`, from });

export async function signIn({ config, profile, profilesPy, exec }) {
  if (profile) {
    const r = await exec("python3", [profilesPy, "account", profile, "jira"]);
    if (r.code === 0) {
      const { site, email, token } = JSON.parse(r.stdout);
      const from = `accounts.jira of profile ${profile} in profiles.json`;
      for (const [name, value] of Object.entries({ site, email, token })) if (!value) throw new Error(`${from} needs "${name}".`);
      return signedIn(site, email, token, from);
    }
    if (r.code !== NO_ACCOUNT_EXIT) throw new Error(`Jira account of profile ${profile}: ${r.stderr.trim() || `profiles.py exit ${r.code}`}`);
  }
  if (!config.site) throw new Error(`No Jira account: give ${profile ? `profile ${profile} an accounts.jira in profiles.json` : "a profile an accounts.jira in profiles.json"}, or set "site" (e.g. "your-company.atlassian.net") in mods/jira/config.json.`);
  if (!config.email) throw new Error('mods/jira/config.json needs "email": the Atlassian account the API token belongs to.');
  const r = await exec("sh", ["-c", PROFILE_FILE_TOKEN]);
  if (r.code === NO_TOKEN_EXIT) throw new Error(`ATLASSIAN_API_KEY is not set: add ATLASSIAN_API_KEY=<token> to ~/.profile (${TOKEN_HELP}).`);
  if (r.code !== 0) throw new Error(`Could not read ATLASSIAN_API_KEY from ~/.profile: ${r.stderr.trim() || `sh exit ${r.code}`}`);
  return signedIn(config.site, config.email, r.stdout.trim(), 'ATLASSIAN_API_KEY in ~/.profile and "email" in mods/jira/config.json');
}
