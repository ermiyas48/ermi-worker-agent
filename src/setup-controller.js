'use strict';
const {isSetupComplete}=require('./config');
const {getBrowserManager}=require('./browser-manager');
class SetupController{constructor(l){this.log=l||console;this.bm=getBrowserManager(this.log);this.setupInProgress=false;} getStatus(){return{setupComplete:isSetupComplete(),setupInProgress:this.setupInProgress};} async startSetupBrowser(){return{ok:false,error:'Full setup-controller not deployed yet. Push remaining source.'};} async detectAuthentication(){return{authenticated:false,setupComplete:isSetupComplete()};} getSetupPageHtml(){return '<html><body><h1>Setup incomplete on server</h1><p>Push remaining source modules.</p></body></html>';}}
let s=null; function getSetupController(l){if(!s)s=new SetupController(l);return s;}
module.exports={SetupController,getSetupController};
