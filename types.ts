export interface Attachment {
  name: string;
  type: 'image' | 'text' | 'pdf' | 'yaml';
  content: string; // Base64 for images, text content for others
  mimeType?: string; // e.g., 'image/jpeg'
}

export interface YamlTopic {
  id: string;
  role: 'user' | 'model';
  content: string;
  attachments?: Attachment[];
  citations?: { uri: string; title: string }[];
  artifacts?: any[];
  timestamp: string;
}

export interface MemorySnapshot {
  id: string;
  summary: string;
  topic_ids: string[]; // Link back to the original topics
  timestamp: string;
}

export interface Context {
  topics: YamlTopic[];
}

export interface Persona {
  name: string;
  system_instruction: string;
}

export interface YamlData {
  version: string;
  persona: Persona;
  context: Context;
  memory_snapshots: MemorySnapshot[];
}

export interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  attachments?: Attachment[];
  citations?: { uri: string; title: string }[];
}