const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || '/usr/bin/google-chrome'});
 try {
 const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const loan={id:'test-owned',name:'Cached test loan',currency:'SEK',startDate:'2025-01-01',initialAmount:100000,interestRate:2,payments:[],interestChanges:[],loanChanges:[]};
 const token='test.'+Buffer.from(JSON.stringify({sub:'cache-test-user',email:'test@example.invalid',exp:4102444800})).toString('base64url')+'.test';
 await page.addInitScript(({token,loan})=>{localStorage.setItem('lendpile_neon_token',token);localStorage.setItem('lendpile_account_loans:cache-test-user',JSON.stringify({data:[loan],savedAt:Date.now()}));}, {token,loan});
 await page.route('**/config.js*',r=>r.fulfill({contentType:'application/javascript',body:'window.LENDPILE_API_URL="https://api.test.invalid";window.NEON_AUTH_URL="https://auth.test.invalid";'}));
 let releaseLoans, releaseShares;
 const loansGate=new Promise(r=>releaseLoans=r),sharesGate=new Promise(r=>releaseShares=r);
 const requests=[];
 await page.route('https://api.test.invalid/**',async r=>{const path=new URL(r.request().url()).pathname;requests.push(path);
 if(path==='/loan-data'){await loansGate;await r.fulfill({json:{data:[{...loan,name:'Fresh test loan'}]}});}
 else if(path.includes('/shares')){await sharesGate;await r.fulfill({json:{shares:[]}});}
 else await r.fulfill({json:{profile:{},admin:false}});
 });
 await page.route('https://auth.test.invalid/**',r=>r.fulfill({status:401,json:{error:'Test session only'}}));
 await page.goto(process.env.LENDPILE_TEST_URL || 'http://127.0.0.1:8768/app.html',{waitUntil:'domcontentloaded'});
 await page.locator('#loans-list').getByText('Cached test loan',{exact:true}).waitFor({timeout:7000}).catch(async e=>{console.log(JSON.stringify({errors,requests,loans:await page.locator('#loans-list').innerText(),state:await page.evaluate(()=>({token:!!localStorage.getItem('lendpile_neon_token'),load:AccountLoadState}))}));throw e;});
 const cached=await page.locator('#loans-list').innerText();
 assert.match(cached,/Refreshing|Uppdaterar|Synkroniserar/i);
 assert.ok(requests.includes('/loan-data'));
 await page.locator('#add-loan-btn').click();
 assert.equal(await page.locator('#loan-modal').isVisible(),false,'cached data must not open edit forms');
 await page.locator('#loans-list [data-action="open"]').first().click();
 assert.equal(await page.locator('#view-detail').isVisible(),true,'cached loans must open for reading');
 await page.evaluate(()=>UIHandler.showLoanList());
 releaseLoans();
 await page.locator('#loans-list').getByText('Fresh test loan',{exact:true}).waitFor({timeout:7000});
 assert.ok(!/Refreshing|Uppdaterar|Synkroniserar/i.test(await page.locator('#loans-list').innerText()));
 releaseShares();
 assert.deepEqual(errors,[]);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('lendpile_account_loans:cache-test-user')).data[0].name),'Fresh test loan');
 await page.locator('#profile-icon-btn').click();
 assert.equal(await page.locator('#profile-settings').isVisible(),true,'Settings must remain in the user menu');
 await page.locator('#profile-settings').click();
 assert.equal(await page.locator('#settings-modal').isVisible(),true);
 assert.equal(await page.locator('#profile-dropdown').evaluate(el=>el.classList.contains('open')),false);
 await page.evaluate(()=>UIHandler.closeModal('settings-modal'));
 await page.locator('#main-actions-menu-btn').click();
 await page.locator('[data-main-action="settings"]').click();
 assert.equal(await page.locator('#settings-modal').isVisible(),true);
 await page.evaluate(()=>UIHandler.closeModal('settings-modal'));
 await page.evaluate(()=>AuthService.signOut());
 assert.equal(await page.evaluate(()=>localStorage.getItem('lendpile_account_loans:cache-test-user')),null);
 assert.equal(await page.evaluate(()=>localStorage.getItem('loanData')),null);
 console.log(JSON.stringify({cachedBeforeServer:true,ownLoansBeforeShares:true,authoritativeCacheSaved:true,signoutClearsCache:true,pageErrors:errors,requests}));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
