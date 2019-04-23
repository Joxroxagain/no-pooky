const puppeteer = require('puppeteer');
const aesjs = require('./aes-mod.js');
const beautify = require('js-beautify').js;

const fs = require('fs');
const https = require('https');
const request = require('request');

const parse = require('./parse.js');

const key = "e29c42ea9b97ad3b5fe1cbdfb373779e820fd0267d2702e61ec36b4a22b07845";

const MAX_RETRIES = 20;

function convertKeArrayToKey(expansionArray) {
    function convertFrom32(int32) {
        let out = [];
        for (let i = 0; i < int32.length; i++) {
            let int = int32[i];
            out.push((256 + (int >> 24)) % 256);
            out.push((256 + (int << 8 >> 24)) % 256);
            out.push((256 + (int << 16 >> 24)) % 256);
            out.push((256 + (int << 24 >> 24)) % 256);
        }
        return out;
    }

    let key32 = [];
    for (let i = 0; i < 2; i++) {
        for (let j = 0; j < expansionArray[i].length; j++) {
            key32.push(expansionArray[i][j]);
        }
    }

    let newKey = convertFrom32(key32);

    return newKey;
}

class DynamicReverser {
    constructor(debug) {
        this.prepared = false;
        this.debug = debug;
        this.encryptWaitingHandles = [];
        this.keWaitingHandles = [];
        this.retries == 0;
    }

    prepare() {
        return new Promise(async (resolve, reject) => {
            if (!this.prepared) {
                this.browser = await puppeteer.launch();
                this.page = await this.browser.newPage();
            }

            // todo: use the actual supreme site if you're not running off a banned VPS provider
            // and otherwise change this to a location on your own filesystem
            // or serve from localhost
            this.page.goto('file:///home/ryan/demo/supreme.htm').then(() => {
                this.prepared = true;
                resolve('Loaded');
            }).catch(err => {
                reject(err);
            });
        });
    }

    /**
     * @param {String} url the pooky url
     */
    getAndReversePooky(url) {
        let startTime = Date.now();
        return new Promise((resolve, reject) => {
            fs.readFile('supreme.htm', 'utf8', (err, data) => {
                let fetchedPage = data;
                if (url /*&& Math.random() > 0.95*/) {
                    fetchedPage = fetchedPage.replace('</head>', `<script type="text/javascript" src="${url}"></script>`);
                }

                let index = fetchedPage.indexOf('pooky');
                if (index == -1) reject("Pooky not found");

                let pookyUrl = fetchedPage.substring(fetchedPage.lastIndexOf('"', index + 1) + 1,
                    fetchedPage.indexOf('"', index));

                console.log(pookyUrl);

                // on drop the pooky url is in the format //assets.supremenewyork.com/pooky.js
                // we have to evaluate this to be able to get a "normal" url to get in node
                this.page.evaluate((urlToParse) => {
                    return Promise.resolve((new URL(urlToParse, "https://www.supremenewyork.com")).href);
                }, pookyUrl).then(normalURL => {
                    console.log(normalURL)
                    request(normalURL, function (err, response, pooky) {
                        if (err) reject(err);

                        // pass the url to the parser
                        // eventually switch to dynamic evaluation instead of AST
                        parse.exposeAES(pooky).then(mod => {
                            console.log(`Reversed pooky in ${Date.now() - startTime} ms`)
                            resolve(mod);
                        }).catch(err => {
                            console.log("Couldn't reverse pooky");
                            console.log(err);
                            reject(err);
                        });
                    });
                })
            })
        });
    }

    injectPooky(pookyMod) {
        if (this.debug) {
            // save a file that you can run in your browser on supremes site
            // includes a pointer to the aes function via window.exposedAES
            // and disabling of the function that prevents cookies from being made
            fs.writeFile('pooky-auto-reverse.js', beautify(pookyMod), (err) => { if (err) console.log(err) });
        }
        return new Promise((resolve, reject) => {
            this.page.addScriptTag({
                content: pookyMod
            }).then(() => {
                this.page.evaluate(() => {
                    return Promise.resolve(keArray);
                }).then(array => {
                    resolve(this.pookyEncrypt);
                })
            }).catch(err => {
                console.log("Error injecting pooky");
                reject(err);
            })
        });
    }

    async stageCompletely(url) {
        this.retries++;
        if (!this.prepared) { await this.prepare() }

        if (typeof this.pookyAES != 'undefined') return;

        this.getAndReversePooky(url).then((mod) => { return this.injectPooky(mod) }).then(encryptFn => {
            console.log('pooky reversed')
            this.pookyAES = encryptFn;

            let extractKe = () => {
                this.page.evaluate(() => {
                    return Promise.resolve(getKeArray());
                }).then(array => {
                    // console.log(array);
                    if (typeof array != 'undefined') {
                        this.keyExpansion = JSON.stringify(array);
                        this.pookyAES = this.keAESFn;
                        for (let handle of this.keWaitingHandles) {
                            handle();
                        }
                    } else {
                        setTimeout(() => {
                            extractKe();
                        }, 50);
                    }
                })
            }
            extractKe();

            this.getKey().then(key => {
                this.pookyAES = (iv, data) => {
                    return new Promise((resolve, reject) => {
                        let aesCbc = new aesjs.ModeOfOperation.cbc(key, iv);
                        resolve(aesCbc.encrypt(aesjs.padding.pkcs7.pad(data)));
                    });
                }

                for (let handle of this.encryptWaitingHandles) {
                    handle(this.pookyAES);
                }
            })
        }).catch(err => {
            console.log(err);
            setTimeout(() => {
                if (this.retries <= MAX_RETRIES) {
                    this.stageCompletely(url);
                } else {
                    if (typeof this.failed == 'function') {
                        this.failed('Could not stage pooky');
                    }
                }
            }, 300);
        });
    }

    encrypt(iv, data) {
        return new Promise((resolve, reject) => {
            this.failed = (reason) => {
                reject(reason);
            }
            let aesReady = (aesFn) => {
                aesFn(iv, data).then(resolve);
            }
            if (typeof this.pookyAES === 'undefined') {
                this.encryptWaitingHandles.push(aesReady);
            } else {
                aesReady(this.pookyAES);
            }
        });
    }

    getKey() {
        return new Promise((resolve, reject) => {
            let keArrayReady = (keArray) => {
                resolve(convertKeArrayToKey(JSON.parse(this.keyExpansion)));
            }
            console.log(this.keyExpansion)

            if (this.keyExpansion) {
                keArrayReady();
            } else {
                this.keWaitingHandles.push(keArrayReady);
            }
        })
    }
}

module.exports.DynamicReverser = DynamicReverser;