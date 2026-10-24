export const defaults = {folder: 'GitHub插件', interval: 1440, auto: true, download: true};
export function repoFrom(value) {
  let u;
  try { u = new URL(value.trim()); } catch { throw new Error('请输入完整 GitHub 项目网址'); }
  const p = u.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.username || u.password || p.length < 2 || !p.slice(0,2).every(x => /^[\w.-]+$/.test(x)) || p.slice(0,2).some(x => x === '.' || x === '..')) throw new Error('只支持 https://github.com/作者/项目');
  return p.slice(0,2).join('/');
}
export function safeName(s) {
  let value = String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0,90);
  if (!value || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = '_' + value;
  return value;
}
export function settings(input) {
  const interval = Number(input.interval);
  if (!Number.isFinite(interval) || interval < 1 || interval > 525600) throw new Error('检查周期应在 1 分钟到 365 天之间');
  const folder = String(input.folder || '').trim();
  if (!folder || folder.length > 80 || /[<>:"/\\|?*\x00-\x1f]/.test(folder) || safeName(folder) !== folder) throw new Error('下载子目录名称无效，请勿填写完整路径');
  return {folder, interval, auto: !!input.auto, download: !!input.download};
}
export function chooseAsset(assets, pattern = '') {
  const candidates = assets.filter(a => /\.(zip|crx|xpi)$/i.test(a.name));
  if (pattern) {
    const re = new RegExp('^' + pattern.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    const match = candidates.filter(a => re.test(a.name));
    return match.length === 1 ? match[0] : null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}
export function assetKey(release, asset) { return `${release.id}:${asset.id}:${asset.updated_at}:${asset.size}`; }
export function projectConfig(p) {
  const repo = repoFrom('https://github.com/' + p.repo);
  const interval = p.interval === '' || p.interval == null ? null : Number(p.interval);
  if (interval !== null && (!Number.isFinite(interval) || interval < 1 || interval > 525600)) throw new Error('项目周期无效');
  return {repo, mode: p.mode === 'source' ? 'source' : 'release', branch: String(p.branch || '').trim().slice(0,200), pattern: String(p.pattern || '').trim().slice(0,200), prerelease: !!p.prerelease, auto: p.auto !== false, interval};
}
export function ownerFrom(value) {
  let v = String(value || '').trim().replace(/^@/, '');
  if (/^https?:\/\//i.test(v)) {
    let u; try { u = new URL(v); } catch { throw new Error('请输入 GitHub 用户名或主页地址'); }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new Error('只支持 github.com 的用户或组织');
    v = u.pathname.split('/').filter(Boolean)[0] || '';
  }
  if (!/^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/.test(v)) throw new Error('GitHub 用户名或组织名无效');
  return v;
}
const FRONTEND = new Set(['JavaScript','TypeScript','HTML','CSS','SCSS','Less','Vue','Svelte']);
export function discoveryTargets(repos) {
  const scan = [], skipped = [];
  for (const r of repos) {
    const reason = r.private ? '私有仓库' : r.fork ? '派生仓库' : r.archived ? '已归档' : r.language && !FRONTEND.has(r.language) ? '语言 ' + r.language : '';
    if (reason) skipped.push({repo:r.full_name, reason}); else scan.push(r);
  }
  return {scan, skipped};
}
// Manifest at the root, or exactly one level down (e.g. extension/), ignoring folders that usually hold web assets.
const ASSET_DIRS = /^(node_modules|public|static|docs?|tests?|examples?|\.github|assets|site|website|vendor)$/i;
export function repoKind(paths) {
  if (paths.includes('manifest.json')) return {kind:'extension', dir:''};
  const sub = paths.filter(p => /^[^/]+\/manifest\.json$/.test(p) && !ASSET_DIRS.test(p.split('/')[0])).map(p => p.split('/')[0]);
  const dir = sub.length === 1 ? sub[0] : ['extension','dist','build','src'].find(d => sub.includes(d));
  if (dir) return {kind:'extension', dir};
  const script = paths.find(p => /\.user\.js$/i.test(p) && p.split('/').length <= 2);
  return script ? {kind:'userscript', script} : {kind:''};
}
export function derivePattern(name, tag = '') {
  const ver = String(tag).replace(/^v/i, ''), i = ver ? name.lastIndexOf(ver) : -1;
  if (i >= 0) return name.slice(0, i) + '*' + name.slice(i + ver.length);
  const m = name.match(/\d+(?:\.\d+)+/);
  return m ? name.slice(0, m.index) + '*' + name.slice(m.index + m[0].length) : name.replace(/(\.[^.]+)$/, '*$1');
}
const OTHER_BUILDS = /(^|[-_.])(source|sources|src|firefox|safari)([-_.]|$)/i;
export function pickAsset(assets = []) {
  let c = assets.filter(a => /\.(zip|crx)$/i.test(a.name) && !OTHER_BUILDS.test(a.name));
  if (c.some(a => /\.zip$/i.test(a.name))) c = c.filter(a => /\.zip$/i.test(a.name));
  if (c.length > 1 && c.some(a => /chrom|edge/i.test(a.name))) c = c.filter(a => /chrom|edge/i.test(a.name));
  return c.length === 1 ? c[0] : c.length ? {ambiguous:c.length} : null;
}
export function releasePlan(releases = []) {
  const list = releases.filter(r => !r.draft);
  // Mirrors inspect(): stable uses /releases/latest, prerelease uses the newest non-draft release.
  const stable = list.find(r => !r.prerelease && pickAsset(r.assets));
  const base = stable || (list[0] && pickAsset(list[0].assets) ? list[0] : null);
  if (!base) return null;
  const asset = pickAsset(base.assets), plan = {prerelease:!stable, tag:base.tag_name};
  if (asset.ambiguous) return {...plan, pattern:'', asset:'', ambiguous:true};
  const pattern = derivePattern(asset.name, base.tag_name);
  return chooseAsset(base.assets, pattern) === asset ? {...plan, pattern, asset:asset.name} : {...plan, pattern:asset.name, asset:asset.name, exact:true};
}
export function discoverConfig(repo, kind, releases = []) {
  const plan = kind.kind === 'extension' ? releasePlan(releases) : null, full = repo.full_name;
  const config = plan ? projectConfig({repo:full, mode:'release', pattern:plan.pattern, prerelease:plan.prerelease}) : projectConfig({repo:full, mode:'source', branch:repo.default_branch});
  const note = kind.kind === 'userscript' ? '油猴脚本，仅跟踪源码' : plan?.ambiguous ? '有多个发布包，请在项目设置中选择' : plan?.exact ? '包名含固定版本号，新版本可能需重新选择' : !plan ? '没有发布包，跟踪源码' + (kind.dir ? `，加载 ${kind.dir} 子目录` : '') : '';
  return {repo:full, kind:kind.kind, dir:kind.dir || '', tag:plan?.tag || '', asset:plan?.asset || '', note, config};
}
const FIELDS = {mode:'下载来源', branch:'源码分支', pattern:'包名规则', prerelease:'包含预发布', auto:'自动检查', interval:'独立周期'};
export function configDiff(a, b) {
  const x = projectConfig(a), y = projectConfig(b), show = v => v === '' || v == null ? '空' : v === true ? '是' : v === false ? '否' : String(v);
  return Object.keys(FIELDS).filter(k => x[k] !== y[k]).map(k => `${FIELDS[k]} ${show(x[k])} → ${show(y[k])}`);
}
export function sameConfig(a, b) { return !configDiff(a, b).length; }
function parseJson(data) { try { return JSON.parse(new TextDecoder().decode(data).replace(/^\uFEFF/, '')); } catch { return null; } }
export function extensionManifest(files) {
  const map = new Map(files.map(f => [f.name, f.data]));
  let dir = '';
  if (!map.has('manifest.json')) { const sub = files.filter(f => /^[^/]+\/manifest\.json$/.test(f.name)); if (sub.length !== 1) return null; dir = sub[0].name.split('/')[0]; }
  const prefix = dir ? dir + '/' : '', m = parseJson(map.get(prefix + 'manifest.json'));
  if (!m || ![2,3].includes(m.manifest_version)) return null;
  let name = String(m.name || '');
  const key = name.match(/^__MSG_(\w+)__$/)?.[1];
  if (key && m.default_locale) { const hit = Object.entries(parseJson(map.get(`${prefix}_locales/${m.default_locale}/messages.json`)) || {}).find(([k]) => k.toLowerCase() === key.toLowerCase()); if (hit?.[1]?.message) name = String(hit[1].message); }
  return {dir, name, version:String(m.version || '')};
}
export function compareVersions(a, b) {
  const x = String(a).split('.'), y = String(b).split('.');
  if (![...x, ...y].every(n => /^\d+$/.test(n))) return 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = Number(x[i] || 0) - Number(y[i] || 0); if (d) return Math.sign(d); }
  return 0;
}
// The management API exposes no install path, so unpacked copies are matched by manifest name unless bound by ID.
export function matchExtension(p, list) {
  const bound = p.extensionId && list.find(e => e.id === p.extensionId);
  if (bound) return bound;
  if (!p.manifest?.name) return null;
  const hits = list.filter(e => e.installType === 'development' && e.name === p.manifest.name);
  return hits.length === 1 ? hits[0] : hits.length ? {ambiguous:hits.length} : null;
}
export function reloadDone(reload, loaded) { return !!loaded?.version && loaded.version === reload.version && reload.was !== reload.version; }
export const outcomes = {updated:'已更新', downloading:'开始下载', latest:'已是最新', available:'有新版本', choose:'需选择发布包', held:'保留本地较新版本', skipped:'已跳过', failed:'失败'};
export function batchSummary(b) {
  const results = Object.values(b.results || {}), counts = {};
  for (const r of results) counts[r.code] = (counts[r.code] || 0) + 1;
  return {done:results.length, total:b.repos.length, text:Object.entries(counts).map(([k, n]) => `${outcomes[k] || k} ${n}`).join(' · ')};
}
