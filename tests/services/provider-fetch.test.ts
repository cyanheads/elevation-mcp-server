/**
 * @fileoverview Actual Node/Bun provider transport against loopback TLS ALPN, cancellation, deadlines and shutdown.
 * @module tests/services/provider-fetch.test
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it.each(['node', 'bun'])(
  '%s provider transport negotiates safely and closes',
  async (runtime) => {
    const directory = await mkdtemp(join(tmpdir(), 'elevation-transport-'));
    const key = join(directory, 'key.pem');
    const cert = join(directory, 'cert.pem');
    try {
      await exec('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ]);
      expect(await readFile(cert, 'utf8')).toContain('BEGIN CERTIFICATE');
      const moduleUrl = new URL('../../src/services/shared/provider-fetch.ts', import.meta.url)
        .href;
      const probe = `
      import assert from 'node:assert/strict';
      import {createSecureServer} from 'node:http2';
      import {once} from 'node:events';
      import {readFileSync} from 'node:fs';
      import {createProviderTransport} from ${JSON.stringify(moduleUrl)};
      let detected=false;try{assert.equal('2.0','1.1');}catch{detected=true;}assert(detected);
      const server=createSecureServer({key:readFileSync(${JSON.stringify(key)}),cert:readFileSync(${JSON.stringify(cert)}),allowHTTP1:true});
      server.on('request',(req,res)=>{if(req.url!='/hang')res.end(req.httpVersion);});
      server.listen(0,'127.0.0.1');await once(server,'listening');
      const origin='https://127.0.0.1:'+server.address().port;
      const native=globalThis.fetch;
      const undici=process.versions.bun?undefined:await import('undici');
      const global=undici?.getGlobalDispatcher();
      const control=undici?new undici.Agent({allowH2:true,connect:{ca:readFileSync(${JSON.stringify(cert)})}}):undefined;
      let transport;
      try{
        if(control){
          const h2=await fetch(origin,{dispatcher:control,signal:AbortSignal.timeout(3000)});
          assert.equal(await h2.text(),'2.0');
        }
        transport=await createProviderTransport();
        if(process.versions.bun)assert.equal(transport.fetch,native);
        else assert.notEqual(transport.fetch,native);
        const response=await transport.fetch(origin,{signal:AbortSignal.timeout(3000),redirect:'manual',headers:{'x-probe':'kept'}});
        assert.equal(await response.text(),'1.1');
        const aborted=new AbortController();aborted.abort();
        await assert.rejects(transport.fetch(origin,{signal:aborted.signal}));
        await assert.rejects(transport.fetch(origin+'/hang',{signal:AbortSignal.timeout(30)}));
        assert.equal(await (await transport.fetch(origin,{signal:AbortSignal.timeout(3000)})).text(),'1.1');
        assert.equal(undici?.getGlobalDispatcher(),global);assert.equal(globalThis.fetch,native);
        const providerFetch=transport.fetch;
        await transport.close();
        transport=undefined;
        if(!process.versions.bun)await assert.rejects(providerFetch(origin));
        console.log('production=1.1; cancellation; timeout recovery; dispatcher unchanged; closed');
        if(control)console.log('H2 control=2.0');
      }finally{
        await transport?.close();await control?.close();server.close();await once(server,'close');
      }
    `;
      const { stdout } = await exec(runtime, ['--input-type=module', '-e', probe], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
        timeout: 15_000,
      });
      expect(stdout).toContain('production=1.1');
      if (runtime === 'node') expect(stdout).toContain('H2 control=2.0');
      expect(stdout).toContain('timeout recovery; dispatcher unchanged; closed');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
