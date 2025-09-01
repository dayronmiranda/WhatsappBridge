/**
 * StatsCollector - Handles metrics and statistics collection
 * Responsibilities:
 * - Event statistics tracking
 * - Message statistics tracking
 * - Performance metrics
 * - Statistics display and reporting
 */
class StatsCollector {
    constructor(config, debugLog) {
        this.config = config;
        this.debugLog = debugLog;
        
        // Event statistics
        this.eventStats = {
            total: 0,
            byType: {},
            lastReset: Date.now(),
            errors: 0,
            filtered: 0,
            ignored: 0
        };

        // Message statistics (NATS publishing)
        this.messageStats = {
            mainSubject: 0,
            contactSubject: 0,
            ignoredSubject: 0,
            presenceSubject: 0,
            lastReset: Date.now(),
            errors: 0
        };

        // Performance statistics
        this.performanceStats = {
            eventProcessingTimes: [],
            averageProcessingTime: 0,
            maxProcessingTime: 0,
            minProcessingTime: Infinity
        };

        // Start periodic stats display if enabled
        this.startPeriodicDisplay();
    }

    /**
     * Update event statistics
     */
    updateEventStats(eventType, action = 'processed') {
        this.eventStats.total++;
        this.eventStats.byType[eventType] = (this.eventStats.byType[eventType] || 0) + 1;
        
        switch (action) {
            case 'error':
                this.eventStats.errors++;
                break;
            case 'filtered':
                this.eventStats.filtered++;
                break;
            case 'ignored':
                this.eventStats.ignored++;
                break;
        }
    }

    /**
     * Update message statistics based on NATS subject
     */
    updateMessageStats(subject, success = true) {
        if (!success) {
            this.messageStats.errors++;
            return;
        }

        if (subject === this.config.nats.subject) {
            this.messageStats.mainSubject++;
        } else if (subject === this.config.nats.contactSubject) {
            this.messageStats.contactSubject++;
        } else if (subject === this.config.nats.ignoredSubject) {
            this.messageStats.ignoredSubject++;
        } else if (subject === this.config.nats.precenseSubject) {
            this.messageStats.presenceSubject++;
        }
    }

    /**
     * Record event processing time
     */
    recordProcessingTime(timeMs) {
        this.performanceStats.eventProcessingTimes.push(timeMs);
        
        // Keep only last 1000 measurements
        if (this.performanceStats.eventProcessingTimes.length > 1000) {
            this.performanceStats.eventProcessingTimes.shift();
        }

        // Update min/max
        this.performanceStats.maxProcessingTime = Math.max(this.performanceStats.maxProcessingTime, timeMs);
        this.performanceStats.minProcessingTime = Math.min(this.performanceStats.minProcessingTime, timeMs);

        // Calculate average
        const times = this.performanceStats.eventProcessingTimes;
        this.performanceStats.averageProcessingTime = times.reduce((a, b) => a + b, 0) / times.length;
    }

    /**
     * Display event statistics
     */
    showEventStats() {
        if (!this.config.debug.enabled) return;
        
        const elapsed = (Date.now() - this.eventStats.lastReset) / 1000;
        const rate = (this.eventStats.total / elapsed).toFixed(2);
        
        console.log('\n📊 EVENT STATISTICS');
        console.log(`Total events: ${this.eventStats.total} (${rate}/sec)`);
        console.log(`Errors: ${this.eventStats.errors}`);
        console.log(`Filtered: ${this.eventStats.filtered}`);
        console.log(`Ignored: ${this.eventStats.ignored}`);
        console.log('Events by type:');
        
        Object.entries(this.eventStats.byType)
            .sort(([,a], [,b]) => b - a)
            .forEach(([type, count]) => {
                console.log(`  ${type}: ${count}`);
            });
        console.log('─'.repeat(40));
    }

    /**
     * Display message statistics
     */
    showMessageStats() {
        if (!this.config.messageStats.enabled) return;
        
        const elapsed = (Date.now() - this.messageStats.lastReset) / 1000;
        const totalMessages = this.messageStats.mainSubject + 
                             this.messageStats.contactSubject + 
                             this.messageStats.ignoredSubject + 
                             this.messageStats.presenceSubject;
        
        console.log('\n📤 MESSAGE STATISTICS');
        console.log(`Main subject (${this.config.nats.subject}): ${this.messageStats.mainSubject} messages`);
        console.log(`Contact subject (${this.config.nats.contactSubject}): ${this.messageStats.contactSubject} messages`);
        console.log(`Ignored subject (${this.config.nats.ignoredSubject}): ${this.messageStats.ignoredSubject} messages`);
        console.log(`Presence subject (${this.config.nats.precenseSubject}): ${this.messageStats.presenceSubject} messages`);
        console.log(`Total sent: ${totalMessages} messages`);
        console.log(`Rate: ${(totalMessages / elapsed).toFixed(2)} msg/sec`);
        console.log(`Errors: ${this.messageStats.errors}`);
        console.log('─'.repeat(50));
    }

    /**
     * Display performance statistics
     */
    showPerformanceStats() {
        if (!this.config.debug.enabled) return;

        const perf = this.performanceStats;
        
        console.log('\n⚡ PERFORMANCE STATISTICS');
        console.log(`Average processing time: ${perf.averageProcessingTime.toFixed(2)}ms`);
        console.log(`Min processing time: ${perf.minProcessingTime === Infinity ? 'N/A' : perf.minProcessingTime.toFixed(2)}ms`);
        console.log(`Max processing time: ${perf.maxProcessingTime.toFixed(2)}ms`);
        console.log(`Samples: ${perf.eventProcessingTimes.length}`);
        console.log('─'.repeat(40));
    }

    /**
     * Get comprehensive statistics summary
     */
    getStatsSummary() {
        const elapsed = (Date.now() - this.eventStats.lastReset) / 1000;
        const totalMessages = this.messageStats.mainSubject + 
                             this.messageStats.contactSubject + 
                             this.messageStats.ignoredSubject + 
                             this.messageStats.presenceSubject;

        return {
            events: {
                total: this.eventStats.total,
                rate: (this.eventStats.total / elapsed).toFixed(2),
                errors: this.eventStats.errors,
                filtered: this.eventStats.filtered,
                ignored: this.eventStats.ignored,
                byType: { ...this.eventStats.byType }
            },
            messages: {
                total: totalMessages,
                rate: (totalMessages / elapsed).toFixed(2),
                errors: this.messageStats.errors,
                bySubject: {
                    main: this.messageStats.mainSubject,
                    contact: this.messageStats.contactSubject,
                    ignored: this.messageStats.ignoredSubject,
                    presence: this.messageStats.presenceSubject
                }
            },
            performance: {
                averageProcessingTime: this.performanceStats.averageProcessingTime,
                minProcessingTime: this.performanceStats.minProcessingTime === Infinity ? null : this.performanceStats.minProcessingTime,
                maxProcessingTime: this.performanceStats.maxProcessingTime,
                samples: this.performanceStats.eventProcessingTimes.length
            },
            uptime: elapsed
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.eventStats = {
            total: 0,
            byType: {},
            lastReset: Date.now(),
            errors: 0,
            filtered: 0,
            ignored: 0
        };

        this.messageStats = {
            mainSubject: 0,
            contactSubject: 0,
            ignoredSubject: 0,
            presenceSubject: 0,
            lastReset: Date.now(),
            errors: 0
        };

        this.performanceStats = {
            eventProcessingTimes: [],
            averageProcessingTime: 0,
            maxProcessingTime: 0,
            minProcessingTime: Infinity
        };

        console.log('📊 Statistics reset');
    }

    /**
     * Start periodic statistics display
     */
    startPeriodicDisplay() {
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
    }

    /**
     * Stop periodic statistics display
     */
    stopPeriodicDisplay() {
        // Note: In a real implementation, you'd want to store interval IDs and clear them
        // For now, this is a placeholder for the interface
    }
}

module.exports = StatsCollector;