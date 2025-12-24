/**
 * Language Server Proto 定义
 * 从 Antigravity 源码分析提取
 */

// Metadata schema 从源码提取：
// field 1: ide_name (string)
// field 2: extension_version (string)
// field 3: api_key (string)
// field 4: locale (string)
// field 5: os (string)
// field 7: ide_version (string)
// field 12: extension_name (string)

export interface Metadata {
    ideName: string       // field 1
    extensionVersion: string  // field 2
    apiKey: string        // field 3
    locale: string        // field 4
    os: string            // field 5
    ideVersion: string    // field 7
    extensionName: string // field 12
}

// CascadeUserMessageItem schema:
// oneof chunk {
//   string text = 1;
//   ContextScopeItem context_scope_item = 2;
//   Tab tab = 3;
// }

export interface CascadeUserMessageItem {
    text?: string  // field 1 of oneof
}

// CascadeConfig - 复杂结构，使用从用户数据提取的字节
export interface CascadeConfig {
    rawBytes: Uint8Array
}

// SendUserCascadeMessageRequest schema:
// field 1: cascade_id (string)
// field 2: items (repeated CascadeUserMessageItem)
// field 3: metadata (Metadata)
// field 5: cascade_config (CascadeConfig)

export interface SendUserCascadeMessageRequest {
    cascadeId: string
    items: CascadeUserMessageItem[]
    metadata: Metadata
    cascadeConfig?: Uint8Array
}

/**
 * 简化的 Protobuf 编码器
 */
export class ProtoEncoder {
    private buffer: number[] = []

    writeVarint(value: number): this {
        while (value > 0x7f) {
            this.buffer.push((value & 0x7f) | 0x80)
            value >>>= 7
        }
        this.buffer.push(value & 0x7f)
        return this
    }

    writeTag(fieldNo: number, wireType: number): this {
        return this.writeVarint((fieldNo << 3) | wireType)
    }

    writeString(fieldNo: number, value: string | undefined): this {
        if (!value) return this
        const bytes = new TextEncoder().encode(value)
        this.writeTag(fieldNo, 2) // length-delimited
        this.writeVarint(bytes.length)
        this.buffer.push(...bytes)
        return this
    }

    writeBytes(fieldNo: number, data: Uint8Array | number[]): this {
        if (!data || data.length === 0) return this
        this.writeTag(fieldNo, 2)
        this.writeVarint(data.length)
        this.buffer.push(...data)
        return this
    }

    writeMessage(fieldNo: number, encoder: ProtoEncoder): this {
        const bytes = encoder.finish()
        return this.writeBytes(fieldNo, bytes)
    }

    finish(): Uint8Array {
        return new Uint8Array(this.buffer)
    }
}

/**
 * 编码 Metadata 消息
 */
export function encodeMetadata(meta: Metadata): ProtoEncoder {
    const encoder = new ProtoEncoder()
    encoder.writeString(1, meta.ideName)
    encoder.writeString(2, meta.extensionVersion)
    encoder.writeString(3, meta.apiKey)
    encoder.writeString(4, meta.locale)
    encoder.writeString(5, meta.os)
    encoder.writeString(7, meta.ideVersion)
    encoder.writeString(12, meta.extensionName)
    return encoder
}

/**
 * 编码 CascadeUserMessageItem 消息
 */
export function encodeItem(item: CascadeUserMessageItem): ProtoEncoder {
    const encoder = new ProtoEncoder()
    if (item.text) {
        encoder.writeString(1, item.text)
    }
    return encoder
}

/**
 * 编码完整的 SendUserCascadeMessageRequest
 */
export function encodeRequest(req: SendUserCascadeMessageRequest): Uint8Array {
    const encoder = new ProtoEncoder()

    // Field 1: cascade_id
    encoder.writeString(1, req.cascadeId)

    // Field 2: items (repeated)
    for (const item of req.items) {
        encoder.writeMessage(2, encodeItem(item))
    }

    // Field 3: metadata
    encoder.writeMessage(3, encodeMetadata(req.metadata))

    // Field 5: cascade_config
    if (req.cascadeConfig) {
        encoder.writeBytes(5, req.cascadeConfig)
    }

    return encoder.finish()
}

/**
 * 用户数据中提取的 CascadeConfig 默认值
 */
export const DEFAULT_CASCADE_CONFIG = new Uint8Array([
    0x0a, 0x22, 0x12, 0x04, 0x20, 0x01, 0x70, 0x01, 0x6a, 0x0b, 0x42, 0x04,
    0x1a, 0x02, 0x30, 0x03, 0x02, 0x02, 0x08, 0x02, 0x7a, 0x03, 0x08, 0xf4,
    0x07, 0xaa, 0x01, 0x02, 0x08, 0x01, 0x02, 0x02, 0x08, 0x01, 0x3a, 0x02,
    0x08, 0x01, 0x58, 0x01
])
