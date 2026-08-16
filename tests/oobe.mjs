import {chromium} from 'playwright-core';

const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
const viewport={width:760,height:430};
const page=await browser.newPage({viewport});
async function assertFooterActionVisible(name){const box=await page.getByRole('button',{name,exact:true}).boundingBox();if(!box||box.y<0||box.y+box.height>viewport.height)throw new Error(`OOBE ${name} button is outside the visible viewport`);}
await page.addInitScript(()=>localStorage.clear());
await page.goto(`${process.env.PATTERN_DESKTOP_URL || 'http://127.0.0.1:1420'}/`);
if(!await page.locator('main.app-shell').evaluate((node)=>node.hasAttribute('inert')&&node.getAttribute('aria-hidden')==='true'))throw new Error('OOBE did not isolate the background from keyboard and assistive technologies');
await assertFooterActionVisible('继续');
await page.getByRole('button',{name:'继续'}).click();
await page.getByText('辅助功能（Windows UIA）').waitFor();
await page.getByRole('button',{name:'打开设置'}).waitFor();
await assertFooterActionVisible('继续');
await page.getByRole('button',{name:'继续'}).click();
await page.getByLabel('名字',{exact:true}).fill('测试人格');
await page.getByLabel('性格与说话方式').fill('说话直接、清楚，重要的事情会主动提醒。');
await assertFooterActionVisible('完成设置');
await page.getByRole('button',{name:'完成设置'}).click();
// The home heading is a time-of-day greeting; the stable main-window marker is the 新对话 button.
await page.getByRole('button',{name:'新对话',exact:true}).waitFor();
if(await page.getByText('首次启动').isVisible().catch(()=>false))throw new Error('OOBE did not close');
await browser.close();
console.log('OOBE completed and main window rendered');
