'use strict';
/**
 * 下载源重写。
 * 国内直连 Mojang 资源往往很慢，BMCLAPI 提供同构镜像；只需改写 host 即可。
 */

const RULES = [
  ['launchermeta.mojang.com', 'bmclapi2.bangbang93.com', ''],
  ['piston-meta.mojang.com', 'bmclapi2.bangbang93.com', ''],
  ['launcher.mojang.com', 'bmclapi2.bangbang93.com', ''],
  ['resources.download.minecraft.net', 'bmclapi2.bangbang93.com', '/assets'],
  ['libraries.minecraft.net', 'bmclapi2.bangbang93.com', '/maven'],
  // client.jar / server.jar 走 objects 路径；国内直连 piston-data 往往只有几十 KB/s
  ['piston-data.mojang.com', 'bmclapi2.bangbang93.com', ''],
];

const MANIFEST = {
  mojang: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  bmcl: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
};

const ASSET_INDEX = {
  mojang: 'https://launchermeta.mojang.com/v1/packages/%s/%s.json',
  bmcl: 'https://bmclapi2.bangbang93.com/v1/packages/%s/%s.json',
};

function rewrite(url, source) {
  if (!url) return url;
  if (source === 'mojang') return url;
  try {
    const u = new URL(url);
    for (const [host, mirror, prefix] of RULES) {
      if (u.hostname === host) {
        const pathPart = prefix + u.pathname;
        return `https://${mirror}${pathPart}${u.search || ''}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

module.exports = { rewrite, MANIFEST, ASSET_INDEX };
