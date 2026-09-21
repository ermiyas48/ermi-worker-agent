'use strict';
class BrowserManager { constructor(l){this.log=l||console;this.lock=false;this.lockOwner=null;} isLocked(){return this.lock;} acquireLock(id){if(this.lock)return false;this.lock=true;this.lockOwner=id;return true;} releaseLock(id){if(this.lockOwner&&this.lockOwner!==id)return false;this.lock=false;this.lockOwner=null;return true;} async ensureBrowser(){throw new Error('Full browser-manager not deployed yet'); } async getPage(){throw new Error('Full browser-manager not deployed yet');} async shutdown(){} async launchForSetup(){return this.ensureBrowser();}}
let instance=null; function getBrowserManager(l){if(!instance)instance=new BrowserManager(l);return instance;}
module.exports={BrowserManager,getBrowserManager};
