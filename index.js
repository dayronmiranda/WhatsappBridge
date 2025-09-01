const readline = require('readline');
const fs = require('fs');

// Import specialized managers
const BrowserManager = require('./src/BrowserManager');
const NATSManager = require('./src/NATSManager');
const EventProcessor = require('./src/EventProcessor');
const StatsCollector = require('./src/StatsCollector');

/**
 * WhatsAppBridge - Main orchestration class
 * Responsibilities:
 * - Coordinate between specialized managers
 * - Handle application lifecycle
 * - Manage user interface
 * - Control event polling loop
 */
class WhatsAppBridge {
    constructor() {
        this.config = JSON.parse(fs.readFileSync('./config/config.json', 'utf8'));
        this.isRunning = false;
        
        // Initialize specialized managers
        this.browserManager = new BrowserManager(this.config, this.debugLog.bind(this));
        this.natsManager = new NATSManager(this.config, this.debugLog.bind(this));
        this.eventProcessor = new EventProcessor(this.config, this.debugLog.bind(this));
        this.statsCollector = new StatsCollector(this.config, this.debugLog.bind(this));
        
        // Set up browser close callback
        this.browserManager.setOnBrowserCloseCallback(() => {
            this.handleBrowserClose();
        });
    }

    /**
     * Debug logging utility
     */
    debugLog(message) {
        if (this.config.debug.enabled) {
            console.log(`🔍 DEBUG: ${message}`);
        }
    }

    /**
     * Launch browser for authentication
     */
    async launchBrowser() {
        return await this.browserManager.launch();
    }

    /**
     * Start the bridge process
     */
    async startBridge() {
        try {
            console.log('Starting WhatsApp Bridge...');
            
            // Initialize NATS connection
            await this.natsManager.connect();
            
            // Wait for WhatsApp authentication
            const authenticated = await this.browserManager.waitForAuthentication();
            if (!authenticated) {
                throw new Error('Authentication failed');
            }

            // Inject event listeners
            await this.browserManager.injectEventListeners();
            
            // Set running state
            this.isRunning = true;
            this.browserManager.setRunning(true);
            
            console.log('✓ Bridge started successfully');
            
            // Start event polling
            this.startEventPolling();
            
        } catch (error) {
            console.error('✗ Failed to start bridge:', error.message);
            this.isRunning = false;
        }
    }

    /**
     * Start the event polling loop
     */
    async startEventPolling() {
        let pollingRetries = 0;

        const pollEvents = async () => {
            if (!this.isRunning) return;

            // Check if browser is still alive
            const browserAlive = await this.browserManager.isAlive();
            if (!browserAlive) {
                console.log('⚠️ Browser not alive, stopping polling');
                this.handleBrowserClose();
                return;
            }

            try {
                // Poll events from browser
                const events = await this.browserManager.pollEvents();

                // Process each event
                for (const event of events) {
                    await this.processEvent(event);
                }

                pollingRetries = 0;
            } catch (error) {
                pollingRetries++;
                
                // Check for fatal browser errors
                if (error.message.includes('Session closed') || 
                    error.message.includes('detached Frame') ||
                    error.message.includes('Protocol error')) {
                    
                    console.log('⚠️ Browser session lost, stopping polling');
                    this.handleBrowserClose();
                    return;
                }

                this.debugLog(`Polling error (attempt ${pollingRetries}): ${error.message}`);
                
                if (pollingRetries >= this.config.polling.maxRetries) {
                    console.log('⚠️ Max polling retries reached, stopping bridge');
                    this.handleBrowserClose();
                    return;
                }

                setTimeout(pollEvents, this.config.polling.retryDelay);
                return;
            }

            // Schedule next poll
            if (this.isRunning) {
                setTimeout(pollEvents, this.config.polling.interval);
            }
        };

        pollEvents();
    }

    /**
     * Process a single event
     */
    async processEvent(event) {
        const startTime = Date.now();
        
        try {
            // Update event stats
            this.statsCollector.updateEventStats(event.type);
            this.debugLog(`Processing event: ${event.type}`);

            // Process event through EventProcessor
            const result = await this.eventProcessor.processEvent(event);

            switch (result.action) {
                case 'publish':
                    // Publish to NATS
                    const publishResult = await this.natsManager.publishEvent(
                        result.eventData, 
                        result.eventType
                    );
                    
                    // Update message stats
                    this.statsCollector.updateMessageStats(publishResult.subject, publishResult.success);
                    
                    // Log transformation if it occurred
                    if (result.wasTransformed && this.config.debug.enabled) {
                        console.log(`🔄 Event transformed: ${result.eventType} -> ${result.eventData.data.type || result.eventType}`);
                    }
                    break;

                case 'ignore':
                    // Publish to ignored subject
                    const ignoreResult = await this.natsManager.publishIgnoredEvent(result.eventData);
                    this.statsCollector.updateMessageStats(ignoreResult.subject, ignoreResult.success);
                    this.statsCollector.updateEventStats(result.eventType, 'ignored');
                    break;

                case 'filter':
                    // Event was filtered out
                    this.statsCollector.updateEventStats(result.eventType, 'filtered');
                    break;

                case 'skip':
                    // Event was skipped due to processing issues
                    this.debugLog(`Event skipped: ${result.reason}`);
                    break;

                case 'error':
                    // Error occurred during processing
                    console.error(`Error processing event ${result.eventType}: ${result.error}`);
                    this.statsCollector.updateEventStats(result.eventType, 'error');
                    break;
            }

        } catch (error) {
            console.error('Error in event processing pipeline:', error.message);
            this.statsCollector.updateEventStats(event.type, 'error');
        } finally {
            // Record processing time
            const processingTime = Date.now() - startTime;
            this.statsCollector.recordProcessingTime(processingTime);
        }
    }

    /**
     * Handle browser close events
     */
    handleBrowserClose() {
        if (this.isRunning) {
            console.log('🔄 Browser closed, stopping bridge...');
            this.isRunning = false;
        }
    }

    /**
     * Stop the bridge
     */
    async stop() {
        this.isRunning = false;
        
        // Close NATS connection
        await this.natsManager.close();
        
        // Close browser
        await this.browserManager.close();
        
        console.log('✓ Bridge stopped');
    }

    /**
     * Show main menu
     */
    showMenu() {
        console.log('\n=== WhatsApp Bridge ===');
        console.log('1. Launch browser for authentication');
        console.log('2. Start bridge');
        console.log('3. Show statistics');
        console.log('4. Reset statistics');
        console.log('5. Exit');
        console.log('========================');
    }

    /**
     * Handle menu choices
     */
    async handleMenuChoice(choice) {
        switch (choice) {
            case '1':
                await this.launchBrowser();
                break;
            case '2':
                if (!this.browserManager.isAvailable()) {
                    console.log('✗ Please launch browser first (option 1)');
                    break;
                }
                await this.startBridge();
                break;
            case '3':
                this.showStatistics();
                break;
            case '4':
                this.statsCollector.resetStats();
                break;
            case '5':
                await this.stop();
                process.exit(0);
                break;
            default:
                console.log('Invalid option. Please choose 1-5.');
        }
    }

    /**
     * Show comprehensive statistics
     */
    showStatistics() {
        console.log('\n' + '='.repeat(60));
        console.log('                    BRIDGE STATISTICS');
        console.log('='.repeat(60));
        
        // Show all statistics
        this.statsCollector.showEventStats();
        this.statsCollector.showMessageStats();
        this.statsCollector.showPerformanceStats();
        
        // Show connection status
        console.log('\n🔗 CONNECTION STATUS');
        console.log(`Browser: ${this.browserManager.isAvailable() ? '✓ Connected' : '✗ Disconnected'}`);
        console.log(`NATS: ${this.natsManager.isConnected() ? '✓ Connected' : '✗ Disconnected'}`);
        console.log(`Bridge: ${this.isRunning ? '✓ Running' : '✗ Stopped'}`);
        
        const natsInfo = this.natsManager.getConnectionInfo();
        if (natsInfo) {
            console.log(`NATS Servers: ${natsInfo.servers.join(', ')}`);
        }
        
        console.log('='.repeat(60));
    }

    /**
     * Main application entry point
     */
    async run() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const askQuestion = () => {
            this.showMenu();
            rl.question('Choose an option: ', async (answer) => {
                await this.handleMenuChoice(answer.trim());
                if (answer.trim() !== '5') {
                    setTimeout(askQuestion, 1000);
                }
            });
        };

        console.log('WhatsApp Bridge v2.0.0 - Modular Architecture');
        console.log('Make sure NATS server is running on localhost:4222\n');
        
        askQuestion();

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            console.log('\nShutting down...');
            await this.stop();
            rl.close();
            process.exit(0);
        });
    }
}

// Start the application
const bridge = new WhatsAppBridge();
bridge.run().catch(console.error);