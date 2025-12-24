/**
 * Language Server Protobuf 定义
 * 基于从 Antigravity 逆向分析的结构
 * 
 * 手动实现 Protobuf 编码，不依赖 @bufbuild/protobuf
 * 
 * Service: exa.language_server_pb.LanguageServerService
 * Endpoint: SendUserCascadeMessage
 */

/**
 * Protobuf Wire Types
 */
const WireType = {
    Varint: 0,
    Fixed64: 1,
    LengthDelimited: 2,
    Fixed32: 5,
}

/**
 * 简单的 Protobuf 编码器
 */
class ProtoWriter {
    private buffer: number[] = []

    /**
     * 写入 varint
     */
    writeVarint(value: number): this {
        while (value > 0x7f) {
            this.buffer.push((value & 0x7f) | 0x80)
            value >>>= 7
        }
        this.buffer.push(value & 0x7f)
        return this
    }

    /**
     * 写入 tag (field number + wire type)
     */
    writeTag(fieldNumber: number, wireType: number): this {
        return this.writeVarint((fieldNumber << 3) | wireType)
    }

    /**
     * 写入字符串
     */
    writeString(fieldNumber: number, value: string): this {
        if (!value) return this
        const bytes = new TextEncoder().encode(value)
        this.writeTag(fieldNumber, WireType.LengthDelimited)
        this.writeVarint(bytes.length)
        for (const byte of bytes) {
            this.buffer.push(byte)
        }
        return this
    }

    /**
     * 写入 bool
     */
    writeBool(fieldNumber: number, value: boolean): this {
        if (!value) return this
        this.writeTag(fieldNumber, WireType.Varint)
        this.writeVarint(value ? 1 : 0)
        return this
    }

    /**
     * 写入 int32/enum
     */
    writeInt32(fieldNumber: number, value: number): this {
        if (value === 0) return this
        this.writeTag(fieldNumber, WireType.Varint)
        this.writeVarint(value)
        return this
    }

    /**
     * 写入嵌套消息
     */
    writeMessage(fieldNumber: number, bytes: Uint8Array): this {
        if (bytes.length === 0) return this
        this.writeTag(fieldNumber, WireType.LengthDelimited)
        this.writeVarint(bytes.length)
        for (const byte of bytes) {
            this.buffer.push(byte)
        }
        return this
    }

    /**
     * 完成编码
     */
    finish(): Uint8Array {
        return new Uint8Array(this.buffer)
    }
}

/**
 * Metadata 元数据
 * Field 1: ide_name
 * Field 2: ide_version  
 * Field 3: extension_version
 * Field 4: extension_name
 * Field 5: api_key (OAuth token)
 * Field 6: locale
 * Field 7: request_id
 */
export interface MetadataData {
    ideName?: string
    ideVersion?: string
    extensionVersion?: string
    extensionName?: string
    apiKey?: string
    locale?: string
    requestId?: string
}

export function encodeMetadata(data: MetadataData): Uint8Array {
    const writer = new ProtoWriter()
    writer.writeString(1, data.ideName || "")
    writer.writeString(2, data.ideVersion || "")
    writer.writeString(3, data.extensionVersion || "")
    writer.writeString(4, data.extensionName || "")
    writer.writeString(5, data.apiKey || "")
    writer.writeString(6, data.locale || "")
    writer.writeString(7, data.requestId || "")
    return writer.finish()
}

/**
 * CascadeUserMessageItem - 用户消息项
 * Field 1: text (oneof chunk)
 */
export interface CascadeUserMessageItemData {
    text?: string
}

export function encodeCascadeUserMessageItem(data: CascadeUserMessageItemData): Uint8Array {
    const writer = new ProtoWriter()
    if (data.text) {
        writer.writeString(1, data.text)
    }
    return writer.finish()
}

/**
 * SendUserCascadeMessageRequest
 * 
 * Fields:
 * - cascade_id = 1 (string)
 * - items = 2 (repeated message)
 * - metadata = 3 (message)
 * - experiment_config = 4 (message)
 * - cascade_config = 5 (message)
 * - images = 6 (repeated message)
 * - blocking = 8 (bool)
 * - additional_steps = 9 (repeated message)
 * - artifact_comments = 10 (repeated message)
 * - client_type = 11 (enum)
 * - file_diff_comments = 12 (repeated message)
 * - file_comments = 13 (repeated message)
 * - media = 14 (repeated message)
 */
export interface SendUserCascadeMessageRequestData {
    cascadeId?: string
    items?: CascadeUserMessageItemData[]
    metadata?: MetadataData
    blocking?: boolean
    clientType?: number
}

export function encodeSendUserCascadeMessageRequest(data: SendUserCascadeMessageRequestData): Uint8Array {
    const writer = new ProtoWriter()

    // cascade_id = 1
    if (data.cascadeId) {
        writer.writeString(1, data.cascadeId)
    }

    // items = 2 (repeated message)
    if (data.items) {
        for (const item of data.items) {
            const itemBytes = encodeCascadeUserMessageItem(item)
            writer.writeMessage(2, itemBytes)
        }
    }

    // metadata = 3 (message)
    if (data.metadata) {
        const metaBytes = encodeMetadata(data.metadata)
        writer.writeMessage(3, metaBytes)
    }

    // blocking = 8 (bool)
    if (data.blocking) {
        writer.writeBool(8, data.blocking)
    }

    // client_type = 11 (enum/int32)
    if (data.clientType) {
        writer.writeInt32(11, data.clientType)
    }

    return writer.finish()
}

/**
 * 创建聊天请求
 */
export function createCascadeRequest(
    cascadeId: string,
    message: string,
    apiKey: string
): Uint8Array {
    const requestData: SendUserCascadeMessageRequestData = {
        cascadeId: cascadeId,
        items: [{ text: message }],
        metadata: {
            ideName: "antigravity",
            ideVersion: "1.13.3b",
            extensionVersion: "1.13.3",
            extensionName: "antigravity",
            apiKey: apiKey,
            locale: "en",
            requestId: crypto.randomUUID(),
        },
        blocking: false,
        clientType: 0,
    }

    return encodeSendUserCascadeMessageRequest(requestData)
}
