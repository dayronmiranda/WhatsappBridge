const path = require('path');

/**
 * EventProcessor - Handles event processing and transformation
 * Responsibilities:
 * - Event transformation using EventTransformers
 * - Event filtering and validation
 * - Event routing decisions
 * - Event data enrichment
 */
class EventProcessor {
    constructor(config, debugLog) {
        this.config = config;
        this.debugLog = debugLog;
        this.eventTransformers = null;
    }

    /**
     * Load EventTransformers module
     */
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

    /**
     * Process a raw event from WhatsApp
     */
    async processEvent(rawEvent) {
        try {
            // Create event data structure
            const eventData = {
                id: Date.now() + Math.random(),
                timestamp: new Date().toISOString(),
                data: rawEvent
            };

            // Load transformers if not already loaded
            if (!this.eventTransformers) {
                this.eventTransformers = this.getEventTransformers();
            }

            if (!this.eventTransformers) {
                console.error('Failed to load EventTransformers, skipping event');
                return {
                    action: 'skip',
                    reason: 'transformers_unavailable'
                };
            }

            // Check if event should be ignored
            const isIgnored = this.eventTransformers.isIgnored(eventData);
            if (isIgnored) {
                return {
                    action: 'ignore',
                    eventData: eventData,
                    eventType: rawEvent.type
                };
            }

            // Transform the event
            const transformedEvent = this.eventTransformers.transform(eventData);

            // Check if event was filtered out
            if (transformedEvent === null) {
                if (this.config.debug.enabled) {
                    console.log(`🚫 Event filtered out: ${rawEvent.type}`);
                }
                return {
                    action: 'filter',
                    reason: 'filtered_by_transformer',
                    eventType: rawEvent.type
                };
            }

            // Event is ready for publishing
            return {
                action: 'publish',
                eventData: transformedEvent,
                originalEventData: eventData,
                eventType: rawEvent.type,
                wasTransformed: transformedEvent !== eventData
            };

        } catch (error) {
            console.error('Error processing event:', error.message);
            return {
                action: 'error',
                error: error.message,
                eventType: rawEvent?.type || 'unknown'
            };
        }
    }

    /**
     * Validate event structure
     */
    validateEvent(event) {
        if (!event) {
            return { valid: false, reason: 'Event is null or undefined' };
        }

        if (!event.type) {
            return { valid: false, reason: 'Event missing type field' };
        }

        if (!event.data) {
            return { valid: false, reason: 'Event missing data field' };
        }

        return { valid: true };
    }

    /**
     * Enrich event with additional metadata
     */
    enrichEvent(event, metadata = {}) {
        return {
            ...event,
            metadata: {
                processedAt: new Date().toISOString(),
                processorVersion: '1.0.0',
                ...metadata
            }
        };
    }

    /**
     * Get processing statistics
     */
    getProcessingStats() {
        return {
            transformersLoaded: !!this.eventTransformers,
            lastTransformerLoad: this.lastTransformerLoad || null
        };
    }

    /**
     * Reload event transformers (useful for hot-reloading)
     */
    reloadTransformers() {
        try {
            this.eventTransformers = this.getEventTransformers();
            this.lastTransformerLoad = new Date().toISOString();
            console.log('✓ EventTransformers reloaded');
            return true;
        } catch (error) {
            console.error('✗ Failed to reload EventTransformers:', error.message);
            return false;
        }
    }
}

module.exports = EventProcessor;