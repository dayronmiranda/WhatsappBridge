const puppeteer = require('rebrowser-puppeteer-core');
const fs = require('fs');
const path = require('path');

/**
 * BrowserManager - Handles all Puppeteer browser operations
 * Responsibilities:
 * - Browser lifecycle management
 * - Page navigation and authentication
 * - Script injection
 * - Browser health monitoring
 */
class BrowserManager {
    constructor(config, debugLog) {
        this.config = config;
        this.debugLog = debugLog;
        this.browser = null;
        this.page = null;
        this.isRunning = false;
        this.onBrowserClose = null;
    }

    /**
     * Set callback for browser close events
     */
    setOnBrowserCloseCallback(callback) {
        this.onBrowserClose = callback;
    }

    /**
     * Launch browser with configured settings
     */
    async launch() {
        try {
            console.log('Launching browser...');
            
            this.browser = await puppeteer.launch({
                executablePath: this.config.browser.executablePath,
                headless: this.config.browser.headless,
                userDataDir: this.config.browser.userDataDir,
                args: this.config.browser.args
            });

            this.browser.on('disconnected', () => {
                console.log('⚠️ Browser disconnected');
                this.handleBrowserClose();
            });

            this.page = await this.browser.newPage();
            
            this.page.on('close', () => {
                console.log('⚠️ Page closed');
                this.handleBrowserClose();
            });

            this.page.on('error', (error) => {
                console.error('⚠️ Page error:', error.message);
                this.handleBrowserClose();
            });

            await this.page.setUserAgent(
                this.config.browser.userAgent || 
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );
            
            console.log('✓ Browser launched successfully');
            console.log('Navigate to WhatsApp Web and authenticate manually');
            
            await this.page.goto(this.config.whatsapp.url, { 
                waitUntil: 'networkidle2',
                timeout: 60000 
            });

            return true;
        } catch (error) {
            console.error('✗ Failed to launch browser:', error.message);
            return false;
        }
    }

    /**
     * Wait for WhatsApp Web authentication
     */
    async waitForAuthentication() {
        try {
            console.log('Waiting for authentication...');
            
            await this.page.waitForSelector(this.config.whatsapp.selectors.mainApp, {
                timeout: 300000
            });
            
            console.log('✓ Authentication successful');
            return true;
        } catch (error) {
            console.error('✗ Authentication timeout or failed');
            return false;
        }
    }

    /**
     * Inject event listeners using store.js
     */
    async injectEventListeners() {
        try {
            this.debugLog('Starting event listener injection...');
            
            // Initialize the event collection array and bridge interface
            await this.page.evaluate(() => {
                window.whatsappEvents = [];
                window.injectionComplete = false;
                window.listenersInjected = 0;
            });

            // Load and inject the store.js script directly
            const storeScript = fs.readFileSync(path.resolve('./store.js'), 'utf8');

            await this.page.addScriptTag({
                content: storeScript
            });

            this.debugLog('Store injection script loaded from store.js');
            console.log('✓ Event listeners injection initiated');
            
            await new Promise(resolve => setTimeout(resolve, this.config.injection.verificationTimeout + 5000));
            
            const verified = await this.verifyInjection();
            if (!verified) {
                throw new Error('Event listener injection verification failed');
            }
            
            console.log('✓ Event listeners injection verified');
            return true;
        } catch (error) {
            console.error('✗ Failed to inject event listeners:', error.message);
            return false;
        }
    }

    /**
     * Verify that event listeners were injected successfully
     */
    async verifyInjection() {
        try {
            this.debugLog('Verifying injection status...');
            
            const injectionStatus = await this.page.evaluate(() => {
                return {
                    storeExists: !!(window.Store && window.Store.Msg),
                    eventsArrayExists: !!window.whatsappEvents,
                    injectionComplete: !!window.injectionComplete,
                    attempts: window.injectionAttempts || 0,
                    listenersCount: window.listenersInjected || 0
                };
            });

            this.debugLog(`Injection status: ${JSON.stringify(injectionStatus)}`);
            
            if (injectionStatus.injectionComplete && injectionStatus.listenersCount > 0) {
                console.log(`✅ Injection verified: ${injectionStatus.listenersCount} listeners active`);
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('Error verifying injection:', error.message);
            return false;
        }
    }

    /**
     * Poll for events from the injected script
     */
    async pollEvents() {
        try {
            const events = await this.page.evaluate(() => {
                const events = window.whatsappEvents || [];
                window.whatsappEvents = [];
                return events;
            });
            return events;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Check if browser is still alive and responsive
     */
    async isAlive() {
        try {
            if (!this.browser || !this.page) return false;
            
            if (this.browser.process() && this.browser.process().killed) {
                return false;
            }
            
            await this.page.evaluate(() => true);
            return true;
        } catch (error) {
            this.debugLog(`Browser alive check failed: ${error.message}`);
            return false;
        }
    }

    /**
     * Handle browser close events
     */
    handleBrowserClose() {
        if (this.isRunning) {
            console.log('🔄 Browser closed, stopping bridge...');
            this.isRunning = false;
            this.browser = null;
            this.page = null;
            
            if (this.onBrowserClose) {
                this.onBrowserClose();
            }
        }
    }

    /**
     * Set running state
     */
    setRunning(isRunning) {
        this.isRunning = isRunning;
    }

    /**
     * Get browser and page instances
     */
    getBrowser() {
        return this.browser;
    }

    getPage() {
        return this.page;
    }

    /**
     * Check if browser is available
     */
    isAvailable() {
        return !!(this.browser && this.page);
    }

    /**
     * Close browser
     */
    async close() {
        if (this.browser) {
            await this.browser.close();
            console.log('✓ Browser closed');
            this.browser = null;
            this.page = null;
        }
    }
}

module.exports = BrowserManager;