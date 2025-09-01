const { connect, StringCodec } = require('nats');

/**
 * NATSManager - Handles all NATS connection and publishing operations
 * Responsibilities:
 * - NATS connection management
 * - Message publishing to different subjects
 * - Connection health monitoring
 * - Subject routing logic
 */
class NATSManager {
    constructor(config, debugLog) {
        this.config = config;
        this.debugLog = debugLog;
        this.connection = null;
        this.sc = StringCodec();
    }

    /**
     * Initialize NATS connection
     */
    async connect() {
        try {
            this.connection = await connect({ 
                servers: this.config.nats.servers,
                maxReconnectAttempts: this.config.nats.maxReconnect
            });
            console.log('✓ NATS connection established');
            return true;
        } catch (error) {
            console.error('✗ NATS connection failed:', error.message);
            throw error;
        }
    }

    /**
     * Publish event to appropriate NATS subject
     */
    async publishEvent(eventData, eventType) {
        if (!this.connection) {
            throw new Error('NATS connection not available');
        }

        try {
            const targetSubject = this.determineSubject(eventType);
            
            await this.connection.publish(
                targetSubject, 
                this.sc.encode(JSON.stringify(eventData))
            );

            if (this.config.debug.enabled) {
                console.log(`📤 Event published to ${targetSubject}: ${eventType}`);
            }

            return {
                subject: targetSubject,
                success: true
            };
        } catch (error) {
            console.error('Error publishing event to NATS:', error.message);
            throw error;
        }
    }

    /**
     * Determine the appropriate NATS subject based on event type
     */
    determineSubject(eventType) {
        // Check if this is a contact-related event
        if (this.isContactEvent(eventType)) {
            return this.config.nats.contactSubject;
        }
        
        // Check if this is a presence-related event
        if (this.isPresenceEvent(eventType)) {
            return this.config.nats.precenseSubject || 'whatsapp.precense';
        }
        
        // Default subject for message events
        return this.config.nats.subject;
    }

    /**
     * Check if event type is contact-related
     */
    isContactEvent(eventType) {
        const contactEventTypes = [
            'contact_add',
            'contact_change', 
            'contact_remove',
            'contacts_initial'
        ];
        return contactEventTypes.includes(eventType);
    }

    /**
     * Check if event type is presence-related
     */
    isPresenceEvent(eventType) {
        const presenceEventTypes = [
            'presence_add',
            'presence_change',
            'presence_remove',
            'presence_initial'
        ];
        return presenceEventTypes.includes(eventType);
    }

    /**
     * Publish to ignored events subject
     */
    async publishIgnoredEvent(eventData) {
        if (!this.connection) {
            throw new Error('NATS connection not available');
        }

        try {
            await this.connection.publish(
                this.config.nats.ignoredSubject,
                this.sc.encode(JSON.stringify(eventData))
            );

            if (this.config.debug.enabled) {
                console.log(`🔀 Event redirected to ignore: ${eventData.data.type}`);
            }

            return {
                subject: this.config.nats.ignoredSubject,
                success: true
            };
        } catch (error) {
            console.error('Error publishing ignored event to NATS:', error.message);
            throw error;
        }
    }

    /**
     * Check if NATS connection is available
     */
    isConnected() {
        return !!(this.connection && !this.connection.isClosed());
    }

    /**
     * Get connection info
     */
    getConnectionInfo() {
        if (!this.connection) return null;
        
        return {
            connected: !this.connection.isClosed(),
            servers: this.config.nats.servers,
            subjects: {
                main: this.config.nats.subject,
                contact: this.config.nats.contactSubject,
                ignored: this.config.nats.ignoredSubject,
                presence: this.config.nats.precenseSubject
            }
        };
    }

    /**
     * Close NATS connection
     */
    async close() {
        if (this.connection) {
            await this.connection.close();
            console.log('✓ NATS connection closed');
            this.connection = null;
        }
    }
}

module.exports = NATSManager;