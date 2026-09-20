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
