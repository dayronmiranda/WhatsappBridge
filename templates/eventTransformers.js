const fs = require('fs');

class EventTransformers {
    constructor() {
        this.eventTypesConfig = JSON.parse(fs.readFileSync('./config/eventTypes.json', 'utf8'));
        this.eventTypes = this.eventTypesConfig.eventTypes || this._getDefaultEventTypes();
        this.messageTypes = this.eventTypesConfig.messageTypes || this._getDefaultMessageTypes();
        this.ignoredTypes = this.eventTypesConfig.ignoredTypes || this._getDefaultIgnoredTypes();
        this.groupActions = this.eventTypesConfig.groupActions || this._getDefaultGroupActions();
    }

    _getDefaultEventTypes() {
        return {
            STATUS_CREATED: "status_created",
            STATUS_RECEIVED: "status_received", 
            STATUS_READ: "status_read",
            MESSAGE_SENT: "message_sent",
            MESSAGE_DELIVERED: "message_delivered",
            MESSAGE_READ: "message_read",
            MESSAGE_PLAYED: "message_played",
            MESSAGE_CREATED: "message_created",
            MESSAGE_REVOKED: "message_revoked",
            DISAPPEARING_MODE_CHANGED: "disappearing_mode_changed"
        };
    }

    _getDefaultMessageTypes() {
        return ['chat', 'image', 'video', 'audio', 'document', 'sticker', 'ptt', 'ptv', 'album', 'gp2', 'revoked', 'notification_template'];
    }

    _getDefaultIgnoredTypes() {
        return [
            { type: "e2e_notification", subtypes: ["encrypt"] },
            { type: "ciphertext" }
        ];
    }

    _getDefaultGroupActions() {
        return {
            add: 'member_added',
            remove: 'member_removed',
            promote: 'member_promoted',
            demote: 'member_demoted',
            modify: 'group_modified',
            create: 'group_created',
            subject: 'name_changed',
            description: 'description_changed',
            picture: 'picture_changed'
        };
    }

    _isStatusEvent(event) {
        return event.data?.data?.id?.remote?._serialized === 'status@broadcast' || 
               event.data?.data?.from?.user === 'status';
    }

    _getEventTypeByAck(ack, isStatus = false) {
        const ackMap = isStatus ? {
            1: this.eventTypes.STATUS_CREATED,
            2: this.eventTypes.STATUS_RECEIVED,
            3: this.eventTypes.STATUS_READ
        } : {
            1: this.eventTypes.MESSAGE_SENT,
            2: this.eventTypes.MESSAGE_DELIVERED,
            3: this.eventTypes.MESSAGE_READ,
            4: this.eventTypes.MESSAGE_PLAYED
        };
        
        return ackMap[ack] || (isStatus ? null : this.eventTypes.MESSAGE_CREATED);
    }

    _isGroupMessage(originalData) {
        return originalData.from?.user?.includes('@g.us') || 
               originalData.id?.remote?.user?.includes('@g.us') ||
               originalData.__raw?.from?.includes('@g.us');
    }

    _normalizeId(id) {
        return id ? id.replace(/@(c\.us|lid)$/, '') : null;
    }

    _getMediaFormat(originalData) {
        const mimetype = originalData.__raw?.mimetype;
        const isAudioOrVideo = mimetype && (mimetype.startsWith('audio/') || mimetype.startsWith('video/'));
        const isText = originalData.type === 'chat' || (!isAudioOrVideo && originalData.body);
        
        return mimetype || (isText ? 'text' : null);
    }

    _buildBaseTransformedEvent(event, originalData, transformedData) {
        return {
            internal_event_id: event.id,
            timestamp: originalData.timestamp ? 
                new Date(originalData.timestamp * 1000).toISOString() : 
                event.timestamp,
            data: transformedData
        };
    }

    shouldIgnoreEvent(event) {
        const eventData = event.data?.data || event.data;
        
        return this.ignoredTypes.some(ignored => {
            if (eventData?.type === ignored.type) {
                if (ignored.subtypes) {
                    return ignored.subtypes.includes(eventData?.subtype || eventData?.__raw?.subtype);
                }
                return true;
            }
            return false;
        });
    }

    isIgnored(event) {
        return this.shouldIgnoreEvent(event);
    }

    transformStatusEvent(event) {
        if (!this._isStatusEvent(event)) return null;

        const originalData = event.data.data;
        const eventType = this._getEventTypeByAck(originalData.ack, true);
        
        if (!eventType) return null;

        const transformedData = {
            status_id: originalData.id?.id || null,
            type: eventType,
            format: this._getMediaFormat(originalData),
            status_author_number: originalData.id?.participant?.user || originalData.from?.user || null,
            reader_number: originalData.to?.user || null,
            read_time: originalData.timestamp?.toString() || null,
            fromMe: originalData.id?.fromMe || false
        };

        if (originalData.body && originalData.type === 'chat') {
            transformedData.body = originalData.body;
        }

        return this._buildBaseTransformedEvent(event, originalData, transformedData);
    }

    transformChatMessage(event) {
        const originalData = event.data?.data;
        if (!originalData || !this.messageTypes.includes(originalData.type)) {
            return null;
        }

        const messageType = this._getEventTypeByAck(originalData.ack);
        const isGroupMessage = this._isGroupMessage(originalData);
        
        const transformedData = {
            message_id: originalData.id?.id || null,
            type: messageType,
            format: originalData.__raw?.mimetype || originalData.type,
            from_number: isGroupMessage ? 
                (originalData.id?.participant?.user || 
                 this._normalizeId(originalData.__raw?.author) || 
                 originalData.from?.user) : 
                (originalData.from?.user || null),
            to_number: originalData.to?.user || null,
            isGroup: isGroupMessage,
            group_id: isGroupMessage ? 
                (originalData.from?.user || originalData.id?.remote?.user || null) : null,
            fromMe: originalData.id?.fromMe || false,
            message_time: originalData.timestamp?.toString() || null
        };

        this._handleSpecialMessageTypes(originalData, transformedData);

        if (originalData.body && originalData.type === 'chat') {
            transformedData.body = originalData.body;
        }

        return this._buildBaseTransformedEvent(event, originalData, transformedData);
    }

    _handleSpecialMessageTypes(originalData, transformedData) {
        switch (originalData.type) {
            case 'notification_template':
                this._handleNotificationTemplate(originalData, transformedData);
                break;
            case 'revoked':
                this._handleRevokedMessage(originalData, transformedData);
                break;
            case 'gp2':
                this._handleGroupEvent(originalData, transformedData);
                break;
        }
    }

    _handleNotificationTemplate(originalData, transformedData) {
        const subtype = originalData.__raw?.subtype;
        
        if (subtype === 'disappearing_mode') {
            transformedData.type = this.eventTypes.DISAPPEARING_MODE_CHANGED;
            transformedData.ephemeral_duration = originalData.__raw?.ephemeralDuration || null;
            transformedData.setting_user = this._normalizeId(originalData.__raw?.ephemeralSettingUser);
        } else {
            transformedData.notification_type = subtype || 'unknown';
        }
    }

    _handleRevokedMessage(originalData, transformedData) {
        transformedData.type = this.eventTypes.MESSAGE_REVOKED;
        transformedData.revoke_timestamp = originalData.__raw?.revokeTimestamp?.toString() || null;
        transformedData.revoked_by = this._normalizeId(
            originalData.id?.participant?.user || originalData.__raw?.author
        );
        transformedData.original_message_id = originalData.__raw?.protocolMessageKey?.id || null;
    }

    _handleGroupEvent(originalData, transformedData) {
        const subtype = originalData.__raw?.subtype;
        const recipients = originalData.__raw?.recipients || [];
        
        transformedData.group_action = this.groupActions[subtype] || subtype || 'unknown';
        transformedData.recipients = recipients.map(id => this._normalizeId(id)).filter(Boolean);
        transformedData.action_by = this._normalizeId(
            originalData.id?.participant?.user || originalData.__raw?.author
        );
    }

    transform(event) {
        if (this.shouldIgnoreEvent(event)) return null;

        const statusTransformed = this.transformStatusEvent(event);
        if (statusTransformed) return statusTransformed;

        const chatTransformed = this.transformChatMessage(event);
        if (chatTransformed) return chatTransformed;

        return event;
    }
}

module.exports = EventTransformers;