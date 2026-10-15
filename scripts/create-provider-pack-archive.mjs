import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdCompress } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createProviderPackArchive(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'provider-pack.json'), 'utf8'));
  if (manifest.schema !== 'paperclip-runner/remote-provider-pack/v1'
    || !/^sha256:[a-f0-9]{64}$/.test(manifest.digest ?? '')) throw Error('Invalid provider pack identity');
  const archive = `${root}.tar.zst`;
  const tar = spawn('tar', ['--no-xattrs', '-cf', '-', '-C', root, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const completed = new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', code => code === 0 ? resolve() : reject(Error('Provider pack archive creation failed')));
  });
  try {
    await Promise.all([completed, pipeline(tar.stdout,
      createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: 3 } }), createWriteStream(archive))]);
  } catch (error) {
    tar.kill();
    throw error;
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const receipt = {
    schema: 'paperclip-runner/provider-pack-archive/v1',
    encoding: 'tar+zstd',
    providerPackDigest: manifest.digest,
    sha256: hash.digest('hex'),
    bytes: (await stat(archive)).size,
  };
  await writeFile(`${root}.archive.json`, JSON.stringify(receipt) + '\n');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || process.argv[3]) throw Error('Usage: create-provider-pack-archive.mjs PACK_ROOT');
  await createProviderPackArchive(resolve(process.argv[2]));
}
