const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),vm=require('node:vm');
const root=__dirname;
const suites=['apps-script/core.test.cjs','tests/runtime.test.cjs','tests/integration.test.cjs','apps-script/ai.test.cjs','tests/output-guard.test.cjs','tests/deployment.test.cjs','gateway/worker.test.mjs'];
for(const test of suites)cp.execFileSync(process.execPath,[path.join(root,test)],{stdio:'inherit'});
for(const name of ['Core.gs','Runtime.gs','AI.gs','Deployment.gs'])new vm.Script(fs.readFileSync(path.join(root,'apps-script',name),'utf8'),{filename:name});
new vm.Script(fs.readFileSync(path.join(root,'hotfix/OutputGuard.gs'),'utf8'),{filename:'hotfix/OutputGuard.gs'});
for(const name of ['demo/index.html','ミリーちゃん_作品準拠サンプル.html']){
 if(name==='demo/index.html' && !fs.existsSync(path.join(root,name)))continue;
 const html=fs.readFileSync(path.join(root,name),'utf8');
 for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1],{filename:name});
 if(!html.includes('https://line.me/R/ti/p/@575kepfk'))throw Error('Expected LINE destination missing');
}
console.log('PASS: Apps Script and embedded browser JavaScript parse; LINE destination verified. No live API calls made.');
