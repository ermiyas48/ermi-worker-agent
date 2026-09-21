'use strict';
const crypto=require('crypto');
const {v4:uuidv4}=require('uuid');
const {isSetupComplete}=require('./config');
const {STATES,HUMAN_LABELS}=require('./states');
const {getBrowserManager}=require('./browser-manager');
function hashPrompt(t){return crypto.createHash('sha256').update(t).digest('hex');}
class RunExecutor{constructor(l){this.log=l||console;this.current=null;this.bm=getBrowserManager(this.log);} getStatus(){if(!this.current)return{state:STATES.IDLE,label:HUMAN_LABELS[STATES.IDLE],locked:this.bm.isLocked(),setupComplete:isSetupComplete()};return{...this.current,label:HUMAN_LABELS[this.current.state]||this.current.state,locked:this.bm.isLocked(),setupComplete:isSetupComplete()};} async startRun(){return{ok:false,error:'Full run-executor / ChatGPT adapter not deployed yet. Push remaining source from the tarball.',state:STATES.FAILED};}}
let executor=null; function getRunExecutor(l){if(!executor)executor=new RunExecutor(l);return executor;}
module.exports={RunExecutor,getRunExecutor,hashPrompt};
