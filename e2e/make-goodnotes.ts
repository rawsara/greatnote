// E2E 용 합성 .goodnotes 생성 (packages/core/test/fixtures 의 생성기를 ZIP 으로 묶음)
import { writeFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { sampleFiles } from '../packages/core/test/fixtures/goodnotes';

const out = process.argv[2];
writeFileSync(out, zipSync(Object.fromEntries(sampleFiles(true))));
console.log('wrote', out);
