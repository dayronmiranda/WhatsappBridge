const puppeteer = require('rebrowser-puppeteer-core');
const { connect, StringCodec } = require('nats');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

class WhatsAppBridge {
    constructor() {
        this.config = JSON.parse(fs.readFileSync('./config/config.json', 'utf8'));
        this.browser = null;
        this.page = null;
        this.natsConnection = null;
        this.isRunning = false;
        this.eventQueue = [];
        this.sc = StringCodec();
        this.eventStats = {
            total: 0,
            byType: {},
            lastReset: Date.now()
        };
        this.messageStats = {
            mainSubject: 0,
            contactSubject: 0,
            ignoredSubject: 0,
            lastReset: Date.now()
        };
    }

    getEventTransformers() {
        try {
            const transformerPath = path.resolve('./templates/eventTransformers.js');
            delete require.cache[transformerPath];
            const EventTransformers = require('./templates/eventTransformers');
            return new EventTransformers();
        } catch (error) {
            console.error('Error loading EventTransformers:', error.message);
            return null;
        }
    }

    async initNATS() {
        try {
            this.natsConnection = await connect({ 
                servers: this.config.nats.servers,
                maxReconnectAttempts: this.config.nats.maxReconnect
            });
            console.log('✓ NATS connection established');
        } catch (error) {
            console.error('✗ NATS connection failed:', error.message);
            throw error;
        }
    }

    async storeEvent(event) {
        if (!this.natsConnection) return;
        
        try {
            const eventData = {
                id: Date.now() + Math.random(),
                timestamp: new Date().toISOString(),
                data: event
            };
            
            const eventTransformers = this.getEventTransformers();
            if (!eventTransformers) {
                console.error('Failed to load EventTransformers, skipping event');
                return;
            }
            
            const isIgnored = eventTransformers.isIgnored(eventData);
            if (isIgnored) {
                await this.natsConnection.publish(
                    this.config.nats.ignoredSubject,
                    this.sc.encode(JSON.stringify(eventData))
                );
                this.messageStats.ignoredSubject++;
                
                if (this.config.debug.enabled) {
                    console.log(`🔀 Event redirected to ignore: ${event.type}`);
                }
                return;
            }
            
            const transformedEvent = eventTransformers.transform(eventData);
            
            if (transformedEvent === null) {
                if (this.config.debug.enabled) {
                    console.log(`🚫 Event filtered out: ${event.type}`);
                }
                return;
            }
            
            // Determine the appropriate NATS subject based on event type
            let targetSubject = this.config.nats.subject; // default subject
            
            // Check if this is a contact-related event
            const isContactEvent = this.isContactEvent(event.type);
            if (isContactEvent) {
                targetSubject = this.config.nats.contactSubject;
                
                if (this.config.debug.enabled) {
                    console.log(`📞 Contact event routed to ${targetSubject}: ${event.type}`);
                }
            } else if (this.isPresenceEvent(event.type)) {
                // Route presence events to dedicated subject; fallback to default if not configured
                targetSubject = this.config.nats.precenseSubject || 'whatsapp.precense';
                if (this.config.debug.enabled) {
                    console.log(`🟢 Presence event routed to ${targetSubject}: ${event.type}`);
                }
            }
            
            await this.natsConnection.publish(
                targetSubject, 
                this.sc.encode(JSON.stringify(transformedEvent))
            );
            
            // Update stats based on subject
            if (targetSubject === this.config.nats.contactSubject) {
                this.messageStats.contactSubject++;
            } else {
                this.messageStats.mainSubject++;
            }
            
            if (transformedEvent !== eventData && this.config.debug.enabled) {
                console.log(`🔄 Event transformed: ${event.type} -> ${transformedEvent.data.type || event.type}`);
            }
        } catch (error) {
            console.error('Error storing event in NATS:', error.message);
        }
    }

    isContactEvent(eventType) {
        const contactEventTypes = [
            'contact_add',
            'contact_change', 
            'contact_remove',
            'contacts_initial'
        ];
        return contactEventTypes.includes(eventType);
    }

    isPresenceEvent(eventType) {
        const presenceEventTypes = [
            'presence_add',
            'presence_change',
            'presence_remove',
            'presence_initial'
        ];
        return presenceEventTypes.includes(eventType);
    }

    async launchBrowser() {
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

            await this.page.setUserAgent(this.config.browser.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
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

    handleBrowserClose() {
        if (this.isRunning) {
            console.log('🔄 Browser closed, stopping bridge...');
            this.isRunning = false;
            this.browser = null;
            this.page = null;
        }
    }

    async isBrowserAlive() {
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

    debugLog(message) {
        if (this.config.debug.enabled) {
            console.log(`🔍 DEBUG: ${message}`);
        }
    }

    updateEventStats(eventType) {
        this.eventStats.total++;
        this.eventStats.byType[eventType] = (this.eventStats.byType[eventType] || 0) + 1;
    }

    showEventStats() {
        if (!this.config.debug.enabled) return;
        
        const elapsed = (Date.now() - this.eventStats.lastReset) / 1000;
        console.log('\n📊 EVENT STATISTICS');
        console.log(`Total events: ${this.eventStats.total} (${(this.eventStats.total / elapsed).toFixed(2)}/sec)`);
        console.log('Events by type:');
        
        Object.entries(this.eventStats.byType)
            .sort(([,a], [,b]) => b - a)
            .forEach(([type, count]) => {
                console.log(`  ${type}: ${count}`);
            });
        console.log('─'.repeat(40));
    }

    showMessageStats() {
        if (!this.config.messageStats.enabled) return;
        
        const elapsed = (Date.now() - this.messageStats.lastReset) / 1000;
        const totalMessages = this.messageStats.mainSubject + this.messageStats.contactSubject + this.messageStats.ignoredSubject;
        
        console.log('\n📤 MESSAGE STATISTICS');
        console.log(`Main subject (${this.config.nats.subject}): ${this.messageStats.mainSubject} messages`);
        console.log(`Contact subject (${this.config.nats.contactSubject}): ${this.messageStats.contactSubject} messages`);
        console.log(`Ignored subject (${this.config.nats.ignoredSubject}): ${this.messageStats.ignoredSubject} messages`);
        console.log(`Total sent: ${totalMessages} messages`);
        console.log(`Rate: ${(totalMessages / elapsed).toFixed(2)} msg/sec`);
        console.log('─'.repeat(50));
    }

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

    async injectEventListeners() {
        try {
            this.debugLog('Starting event listener injection...');
            
            await this.page.evaluate(() => {
                window.whatsappEvents = [];
                window.injectionComplete = false;
                window.listenersInjected = 0;
                
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                
                function log(msg) {
                    console.log('[WhatsAppBridge]', msg);
                }
                
                function exposeStore() {
                    try {
                        log('Attempting to expose Store using window.require...');
                        
                        if (!window.require) {
                            log('window.require not available');
                            return false;
                        }

                        window.Store = Object.assign({}, window.require('WAWebCollections'));
                        window.Store.Conn = window.require('WAWebConnModel').Conn;
                        window.Store.Cmd = window.require('WAWebCmd').Cmd;
                        window.Store.User = window.require('WAWebUserPrefsMeUser');

                        // Try to expose Contact collection and methods (best-effort)
                        try {
                            const contactCollectionModule = window.require('WAWebContactCollection');
                            if (contactCollectionModule && contactCollectionModule.ContactCollection) {
                                window.Store.Contact = contactCollectionModule.ContactCollection;
                                log('Added Contact collection');
                            }
                        } catch (e) {
                            log('ContactCollection not found: ' + e.message);
                        }
                        try {
                            window.Store.ContactMethods = window.require('WAWebContactGetters');
                            log('Added ContactMethods');
                        } catch (e) {
                            log('ContactMethods not found: ' + e.message);
                        }
                        // Try to expose Presence collection (best-effort)
                        try {
                            const presenceModule = window.require('WAWebPresenceCollection');
                            if (presenceModule && presenceModule.PresenceCollection) {
                                window.Store.Presence = presenceModule.PresenceCollection;
                                log('Added Presence collection');
                            }
                        } catch (e) {
                            log('Presence collection not found: ' + e.message);
                        }
                        
                        log('Store exposed successfully');
                        return true;
                    } catch (e) {
                        log('Failed to expose Store: ' + String(e));
                        return false;
                    }
                }

                function findStore() {
                    log('Looking for Store...');
                    
                    if (window.Store && window.Store.Msg && window.Store.Conn) {
                        log('Found complete window.Store');
                        return window.Store;
                    }

                    if (exposeStore()) {
                        if (window.Store && window.Store.Msg && window.Store.Conn) {
                            log('Successfully exposed and found Store');
                            return window.Store;
                        }
                    }

                    try {
                        if (window.webpackChunkwhatsapp_web_client) {
                            const chunk = window.webpackChunkwhatsapp_web_client;
                            
                            let webpackRequire;
                            chunk.push([
                                ['__WhatsAppBridge__'],
                                {},
                                (r) => { webpackRequire = r; }
                            ]);
                            
                            if (webpackRequire) {
                                log('Got webpack require via chunk');
                                if (!window.require) {
                                    window.require = webpackRequire;
                                    log('Set window.require from webpack');
                                    
                                    if (exposeStore()) {
                                        if (window.Store && window.Store.Msg && window.Store.Conn) {
                                            log('Successfully exposed Store via webpack require');
                                            return window.Store;
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        log('Webpack chunk approach failed: ' + String(e));
                    }

                    log('No Store found');
                    return null;
                }

                async function waitForStore() {
                    for (let i = 0; i < 300; i++) {
                        const store = findStore();
                        if (store) {
                            log('Store found after ' + (i * 100) + 'ms');
                            return store;
                        }
                        await sleep(100);
                    }
                    log('Store not found after 30s');
                    return null;
                }

                function serializeMsg(msg) {
                    try {
                        const result = {};
                        
                        if (msg.id) result.id = msg.id;
                        if (msg.body) result.body = msg.body;
                        if (msg.type) result.type = msg.type;
                        if (msg.from) result.from = msg.from;
                        if (msg.to) result.to = msg.to;
                        if (msg.t) result.timestamp = msg.t;
                        if (msg.ack !== undefined) result.ack = msg.ack;
                        if (msg.isNewMsg !== undefined) result.isNewMsg = msg.isNewMsg;
                        
                        try {
                            result.__raw = JSON.parse(JSON.stringify(msg));
                        } catch (_) {
                            result.__raw_error = 'Could not serialize full object';
                        }
                        
                        return result;
                    } catch (e) {
                        log('Serialize error: ' + String(e));
                        return { 
                            id: msg && msg.id, 
                            body: msg && msg.body,
                            error: 'serialization_failed'
                        };
                    }
                }

                function serializeContact(contact) {
                    try {
                        const normalizeJid = (id) => id ? String(id).replace(/@(c\.us|lid)$/,'') : null;
                        const getId = () => {
                            if (!contact) return null;
                            if (contact.id && (contact.id._serialized || typeof contact.id === 'string')) {
                                return contact.id._serialized || contact.id;
                            }
                            return contact.phoneNumber || null;
                        };
                        const jid = getId();
                        const number = normalizeJid(jid);
                        const CM = (window.Store && window.Store.ContactMethods) || null;

                        const bool = (fallback, method) => {
                            try { return CM && method ? method(contact) : fallback; } catch (_) { return fallback; }
                        };

                        const data = {
                            id: jid || null,
                            number: number,
                            name: contact?.name || null,
                            pushname: contact?.pushname || null,
                            verifiedName: contact?.verifiedName || null,
                            formattedName: contact?.formattedName || null,
                            shortName: contact?.shortName || null,
                            isMe: bool(!!contact?.isMe, CM?.getIsMe),
                            isUser: bool(!!contact?.isUser, CM?.getIsUser),
                            isGroup: bool(!!contact?.isGroup, CM?.getIsGroup),
                            isBusiness: bool(!!contact?.isBusiness, CM?.getIsBusiness),
                            isWAContact: bool(!!contact?.isWAContact, CM?.getIsWAContact),
                            isMyContact: bool(!!contact?.isMyContact, CM?.getIsMyContact),
                            isBlocked: (contact?.isContactBlocked !== undefined) ? contact.isContactBlocked : (contact?.isBlocked || false),
                            isEnterprise: bool(!!contact?.isEnterprise, CM?.getIsEnterprise),
                            userid: contact?.userid || (CM ? CM.getUserid?.(contact) : null) || null,
                            phoneNumber: contact?.phoneNumber || number || null
                        };

                        if (typeof contact?.about === 'string') data.about = contact.about;
                        if (typeof contact?.status === 'string') data.status = contact.status;
                        if (contact?.t) data.timestamp = contact.t;
                        if (contact?.lastSeen) data.lastSeen = contact.lastSeen;

                        return data;
                    } catch (e) {
                        log('Contact serialize error: ' + String(e));
                        return { id: contact?.id?._serialized || contact?.id || null, error: 'contact_serialization_failed' };
                    }
                }

                function serializePresence(p) {
                    try {
                        // Pass through everything JSON-serializable
                        return JSON.parse(JSON.stringify(p));
                    } catch (_) {
                        return { id: p?.id?._serialized || p?.id || null, __raw_error: 'Could not serialize presence' };
                    }
                }

                async function setup() {
                    log('Starting store setup...');
                    const Store = await waitForStore();
                    if (!Store) {
                        log('No Store found, cannot setup listeners');
                        window.injectionComplete = false;
                        return;
                    }

                    log('Store available, setting up listeners...');

                    try {
                        if (Store.Msg && Store.Msg.on) {
                            const processedMessages = new Map();
                            
                            const shouldProcessMessage = (msg, eventType) => {
                                if (!msg || !msg.id || !msg.id._serialized) return false;
                                
                                const messageId = msg.id._serialized;
                                const key = `${messageId}_${eventType}_${msg.ack || 0}`;
                                
                                if (processedMessages.has(key)) {
                                    return false;
                                }
                                
                                processedMessages.set(key, Date.now());
                                
                                if (processedMessages.size > 1000) {
                                    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
                                    for (const [k, timestamp] of processedMessages.entries()) {
                                        if (timestamp < fiveMinutesAgo) {
                                            processedMessages.delete(k);
                                        }
                                    }
                                }
                                
                                return true;
                            };
                            
                            Store.Msg.on('add', (msg) => {
                                if (shouldProcessMessage(msg, 'create')) {
                                    log('Message added: ' + (msg.body || msg.type || 'unknown'));
                                    window.whatsappEvents.push({
                                        type: 'message_create',
                                        data: serializeMsg(msg),
                                        timestamp: Date.now()
                                    });
                                }
                            });
                            
                            Store.Msg.on('change', (msg) => {
                                if (msg.ack !== undefined) {
                                    if (msg.ack === 1 && shouldProcessMessage(msg, 'received')) {
                                        log('Message received: ack=1');
                                        window.whatsappEvents.push({
                                            type: 'message_received',
                                            data: serializeMsg(msg),
                                            timestamp: Date.now()
                                        });
                                    } else if (msg.ack === 2 && shouldProcessMessage(msg, 'delivered')) {
                                        log('Message delivered: ack=2');
                                        window.whatsappEvents.push({
                                            type: 'message_delivered',
                                            data: serializeMsg(msg),
                                            timestamp: Date.now()
                                        });
                                    } else if (msg.ack === 3 && shouldProcessMessage(msg, 'read')) {
                                        log('Message read: ack=3');
                                        window.whatsappEvents.push({
                                            type: 'message_read',
                                            data: serializeMsg(msg),
                                            timestamp: Date.now()
                                        });
                                    }
                                }
                            });
                            
                            window.listenersInjected = 2;
                            log('Message listeners attached to Store.Msg with deduplication');
                        } else {
                            log('Store.Msg exists but no .on method');
                        }
                    } catch (e) {
                        log('Message setup error: ' + String(e));
                    }

                    // Contact events with deduplication and batching
                    try {
                        const getContactCollection = () => {
                            if (Store.Contact && typeof Store.Contact.on === 'function') return Store.Contact;
                            try {
                                const mod = window.require && window.require('WAWebContactCollection');
                                if (mod && mod.ContactCollection) return mod.ContactCollection;
                            } catch (e) {}
                            return null;
                        };

                        const Contact = getContactCollection();
                        if (Contact) {
                            log('Setting up contact listeners');
                            const seen = new Map();
                            const shouldProcess = (key, ttlMs) => {
                                const now = Date.now();
                                const last = seen.get(key) || 0;
                                if (now - last < ttlMs) return false;
                                seen.set(key, now);
                                if (seen.size > 1000) {
                                    const cutoff = now - 10 * 60 * 1000;
                                    for (const [k, ts] of seen) if (ts < cutoff) seen.delete(k);
                                }
                                return true;
                            };
                            const getKey = (contact, type) => {
                                const id = (contact?.id?._serialized || contact?.id || contact?.phoneNumber || 'unknown');
                                return `${id}_${type}`;
                            };

                            if (typeof Contact.on === 'function') {
                                Contact.on('add', (c) => {
                                    const key = getKey(c, 'add');
                                    if (!shouldProcess(key, 120000)) return;
                                    window.whatsappEvents.push({ type: 'contact_add', data: serializeContact(c), timestamp: Date.now() });
                                });

                                Contact.on('change', (c) => {
                                    const key = getKey(c, 'change');
                                    if (!shouldProcess(key, 5000)) return;
                                    window.whatsappEvents.push({ type: 'contact_change', data: serializeContact(c), timestamp: Date.now() });
                                });

                                Contact.on('remove', (c) => {
                                    const key = getKey(c, 'remove');
                                    if (!shouldProcess(key, 120000)) return;
                                    window.whatsappEvents.push({ type: 'contact_remove', data: serializeContact(c), timestamp: Date.now() });
                                });

                                // Initial contacts batching
                                try {
                                    const getAll = () => {
                                        if (typeof Contact.getModelsArray === 'function') return Contact.getModelsArray();
                                        if (Array.isArray(Contact.models)) return Contact.models;
                                        return [];
                                    };
                                    const all = getAll();
                                    const total = all.length;
                                    if (total > 0) {
                                        const batchSize = 200;
                                        for (let i = 0; i < total; i += batchSize) {
                                            const slice = all.slice(i, i + batchSize).map(serializeContact);
                                            window.whatsappEvents.push({
                                                type: 'contacts_initial',
                                                data: {
                                                    countTotal: total,
                                                    batchIndex: Math.floor(i / batchSize),
                                                    batchSize: slice.length,
                                                    contacts: slice
                                                },
                                                timestamp: Date.now()
                                            });
                                        }
                                    }
                                } catch (e) {
                                    log('Failed to emit initial contacts: ' + String(e));
                                }

                                window.listenersInjected += 3;
                                log('Contact listeners attached');
                            } else {
                                log('Contact collection has no .on method');
                            }
                        } else {
                            log('No Contact collection available');
                        }
                    } catch (e) {
                        log('Contact setup error: ' + String(e));
                    }

                    // Presence events (no filtering, pass-through)
                    try {
                        const getPresenceCollection = () => {
                            if (Store.Presence && typeof Store.Presence.on === 'function') return Store.Presence;
                            try {
                                const mod = window.require && window.require('WAWebPresenceCollection');
                                if (mod && mod.PresenceCollection) return mod.PresenceCollection;
                            } catch (e) {}
                            return null;
                        };
                        const Presence = getPresenceCollection();
                        if (Presence) {
                            log('Setting up presence listeners');
                            if (typeof Presence.on === 'function') {
                                Presence.on('add', (p) => {
                                    window.whatsappEvents.push({ type: 'presence_add', data: serializePresence(p), timestamp: Date.now() });
                                });
                                Presence.on('change', (p) => {
                                    window.whatsappEvents.push({ type: 'presence_change', data: serializePresence(p), timestamp: Date.now() });
                                });
                                Presence.on('remove', (p) => {
                                    window.whatsappEvents.push({ type: 'presence_remove', data: serializePresence(p), timestamp: Date.now() });
                                });
                                // Initial snapshot if available
                                try {
                                    const getAll = () => {
                                        if (typeof Presence.getModelsArray === 'function') return Presence.getModelsArray();
                                        if (Array.isArray(Presence.models)) return Presence.models;
                                        return [];
                                    };
                                    const all = getAll();
                                    if (all.length > 0) {
                                        window.whatsappEvents.push({
                                            type: 'presence_initial',
                                            data: { countTotal: all.length, presences: all.map(serializePresence) },
                                            timestamp: Date.now()
                                        });
                                    }
                                } catch (e) {
                                    log('Failed to emit initial presence: ' + String(e));
                                }
                                window.listenersInjected += 3;
                                log('Presence listeners attached');
                            } else {
                                log('Presence collection has no .on method');
                            }
                        } else {
                            log('No Presence collection available');
                        }
                    } catch (e) {
                        log('Presence setup error: ' + String(e));
                    }

                    window.injectionComplete = true;
                    log('Store setup complete');
                }

                log('Store script loaded, starting setup...');
                setTimeout(() => {
                    setup().catch(e => log('Setup failed: ' + String(e)));
                }, 2000);
            });

            this.debugLog('Store injection script loaded');
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

    async startBridge() {
        try {
            console.log('Starting WhatsApp Bridge...');
            
            await this.initNATS();
            
            const authenticated = await this.waitForAuthentication();
            if (!authenticated) {
                throw new Error('Authentication failed');
            }

            await this.injectEventListeners();
            
            this.isRunning = true;
            console.log('✓ Bridge started successfully');
            
            this.startEventPolling();
            
        } catch (error) {
            console.error('✗ Failed to start bridge:', error.message);
            this.isRunning = false;
        }
    }

    async startEventPolling() {
        if (this.config.debug.enabled) {
            setInterval(() => {
                this.showEventStats();
            }, this.config.debug.statsInterval);
        }

        if (this.config.messageStats.enabled) {
            setInterval(() => {
                this.showMessageStats();
            }, this.config.messageStats.displayInterval);
        }

        let pollingRetries = 0;

        const pollEvents = async () => {
            if (!this.isRunning) return;

            const browserAlive = await this.isBrowserAlive();
            if (!browserAlive) {
                console.log('⚠️ Browser not alive, stopping polling');
                this.handleBrowserClose();
                return;
            }

            try {
                const events = await this.page.evaluate(() => {
                    const events = window.whatsappEvents || [];
                    window.whatsappEvents = [];
                    return events;
                });

                for (const event of events) {
                    this.updateEventStats(event.type);
                    await this.storeEvent(event);
                    this.debugLog(`Event stored: ${event.type}`);
                }

                pollingRetries = 0;
            } catch (error) {
                pollingRetries++;
                
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

            if (this.isRunning) {
                setTimeout(pollEvents, this.config.polling.interval);
            }
        };

        pollEvents();
    }

    async stop() {
        this.isRunning = false;
        
        if (this.natsConnection) {
            await this.natsConnection.close();
            console.log('✓ NATS connection closed');
        }
        
        if (this.browser) {
            await this.browser.close();
            console.log('✓ Browser closed');
        }
    }

    showMenu() {
        console.log('\n=== WhatsApp Bridge ===');
        console.log('1. Launch browser for authentication');
        console.log('2. Start bridge');
        console.log('3. Exit');
        console.log('========================');
    }

    async handleMenuChoice(choice) {
        switch (choice) {
            case '1':
                await this.launchBrowser();
                break;
            case '2':
                if (!this.browser || !this.page) {
                    console.log('✗ Please launch browser first (option 1)');
                    break;
                }
                await this.startBridge();
                break;
            case '3':
                await this.stop();
                process.exit(0);
                break;
            default:
                console.log('Invalid option. Please choose 1, 2, or 3.');
        }
    }

    async run() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const askQuestion = () => {
            this.showMenu();
            rl.question('Choose an option: ', async (answer) => {
                await this.handleMenuChoice(answer.trim());
                if (answer.trim() !== '3') {
                    setTimeout(askQuestion, 1000);
                }
            });
        };

        console.log('WhatsApp Bridge v1.0.0');
        console.log('Make sure NATS server is running on localhost:4222\n');
        
        askQuestion();

        process.on('SIGINT', async () => {
            console.log('\nShutting down...');
            await this.stop();
            rl.close();
            process.exit(0);
        });
    }
}

const bridge = new WhatsAppBridge();
bridge.run().catch(console.error);