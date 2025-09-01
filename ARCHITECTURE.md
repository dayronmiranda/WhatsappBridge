# WhatsApp Bridge - Modular Architecture

## Overview

The WhatsApp Bridge has been refactored from a monolithic class into a modular architecture with clear separation of responsibilities. This improves maintainability, testability, and extensibility.

## Architecture Components

### 1. WhatsAppBridge (Main Orchestrator)
**File**: `index.js`
**Responsibilities**:
- Coordinate between specialized managers
- Handle application lifecycle
- Manage user interface and menu system
- Control the main event polling loop
- Process events through the pipeline

### 2. BrowserManager
**File**: `src/BrowserManager.js`
**Responsibilities**:
- Browser lifecycle management (launch, close, health checks)
- Page navigation and WhatsApp Web authentication
- Script injection (store.js)
- Event polling from injected scripts
- Browser state monitoring

**Key Methods**:
- `launch()` - Launch Puppeteer browser
- `waitForAuthentication()` - Wait for WhatsApp login
- `injectEventListeners()` - Inject store.js script
- `pollEvents()` - Retrieve events from browser
- `isAlive()` - Check browser health

### 3. NATSManager
**File**: `src/NATSManager.js`
**Responsibilities**:
- NATS connection management
- Message publishing to different subjects
- Subject routing logic (main, contact, presence, ignored)
- Connection health monitoring

**Key Methods**:
- `connect()` - Establish NATS connection
- `publishEvent()` - Publish to appropriate subject
- `publishIgnoredEvent()` - Publish to ignored subject
- `determineSubject()` - Route events to correct subject
- `isConnected()` - Check connection status

### 4. EventProcessor
**File**: `src/EventProcessor.js`
**Responsibilities**:
- Event transformation using EventTransformers
- Event filtering and validation
- Event routing decisions
- Event data enrichment

**Key Methods**:
- `processEvent()` - Main event processing pipeline
- `getEventTransformers()` - Load transformer modules
- `validateEvent()` - Validate event structure
- `enrichEvent()` - Add metadata to events
- `reloadTransformers()` - Hot-reload transformers

### 5. StatsCollector
**File**: `src/StatsCollector.js`
**Responsibilities**:
- Event statistics tracking
- Message statistics tracking (by NATS subject)
- Performance metrics (processing times)
- Statistics display and reporting

**Key Methods**:
- `updateEventStats()` - Track event counts by type
- `updateMessageStats()` - Track NATS publishing stats
- `recordProcessingTime()` - Track performance metrics
- `showEventStats()` - Display event statistics
- `showMessageStats()` - Display NATS statistics
- `getStatsSummary()` - Get comprehensive stats

## Event Processing Pipeline

```
Raw Event (from browser)
    ↓
EventProcessor.processEvent()
    ↓
Event Validation & Transformation
    ↓
Routing Decision (publish/ignore/filter)
    ↓
NATSManager.publishEvent()
    ↓
StatsCollector.updateStats()
```

## Benefits of Modular Architecture

### 1. **Single Responsibility Principle**
Each class has a clear, focused responsibility:
- BrowserManager: Only handles browser operations
- NATSManager: Only handles NATS operations
- EventProcessor: Only handles event processing
- StatsCollector: Only handles metrics
- WhatsAppBridge: Only orchestrates components

### 2. **Improved Maintainability**
- Changes to browser logic only affect BrowserManager
- NATS configuration changes only affect NATSManager
- Statistics features only affect StatsCollector
- Easier to locate and fix bugs

### 3. **Better Testability**
- Each component can be unit tested independently
- Mock dependencies easily for isolated testing
- Clear interfaces between components

### 4. **Enhanced Extensibility**
- Easy to add new event processors
- Simple to implement new statistics collectors
- Straightforward to support different browsers
- Easy to add new NATS features

### 5. **Reduced Coupling**
- Components communicate through well-defined interfaces
- Changes in one component don't cascade to others
- Easier to replace or upgrade individual components

## Configuration

The modular architecture maintains backward compatibility with the existing `config/config.json` structure. Each manager receives the full config object and extracts its relevant sections.

## Error Handling

Each component handles its own errors and reports them through the main orchestrator. This provides:
- Better error isolation
- More specific error messages
- Graceful degradation when components fail

## Future Enhancements

The modular architecture makes it easy to add:
- Multiple browser support (Chrome, Firefox, etc.)
- Different message brokers (Redis, RabbitMQ, etc.)
- Advanced event processors (ML-based filtering, etc.)
- Real-time dashboards and monitoring
- Plugin system for custom processors

## Migration Notes

- All existing functionality is preserved
- Configuration format remains the same
- API compatibility is maintained
- Performance is improved due to better separation of concerns