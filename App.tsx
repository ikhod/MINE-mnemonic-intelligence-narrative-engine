import React, { useState, useEffect } from 'react';
import { Message, Attachment, YamlData, YamlTopic, Persona, MemorySnapshot } from './types';
import { sendMessageStream, startChat, generateImage, generateSummary, findRelevantMemory, generateAutonomousSummary } from './services/geminiService';
import type { Chat } from '@google/genai';

import Header from './components/Header';
import ChatInterface from './components/ChatInterface';
import ChatInput from './components/ChatInput';
import WelcomeScreen from './components/WelcomeScreen';
import YamlEditor from './components/YamlEditor';
import PersonaEditor from './components/PersonaEditor';
import MemorySnapshots from './components/MemorySnapshots';
import { LedgerIcon, MemoryIcon } from './components/Icons';

const INITIAL_YAML_STRING = `version: "1.0"
persona:
  name: Gemini
  system_instruction: You are a helpful AI assistant.
context:
  topics: []
memory_snapshots: []
`;

// --- START OF NEW/MODIFIED CODE ---
// Define specific markers for explicit model-initiated snapshots
const SNAPSHOT_START_MARKER = "---\n**Memory Snapshot Created (Autonomously):**\n\n";
const SNAPSHOT_END_MARKER = "\n\n---";
// --- END OF NEW/MODIFIED CODE ---

const mapYamlTopicToMessage = (topic: YamlTopic): Message => ({
  id: topic.id,
  role: topic.role,
  text: topic.content,
  attachments: topic.attachments,
  citations: topic.citations,
});

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isModelLoading, setIsModelLoading] = useState<boolean>(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false);
  const [sidebarTab, setSidebarTab] = useState<'ledger' | 'memory'>('ledger');
  const [chatMode, setChatMode] = useState<'ask' | 'imagine' | 'web'>('ask');

  // YAML State
  const [yamlString, setYamlString] = useState<string>(INITIAL_YAML_STRING);
  const [yamlData, setYamlData] = useState<YamlData | null>(() => {
    try {
      return (window as any).jsyaml.load(INITIAL_YAML_STRING) as YamlData;
    } catch (e) {
      console.error("Error parsing initial YAML", e);
      return null;
    }
  });
  const [isYamlValid, setIsYamlValid] = useState<boolean>(true);
  const [isPersonaEditorOpen, setIsPersonaEditorOpen] = useState(false);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isAutoSummarizing, setIsAutoSummarizing] = useState(false);
  const [isExportingPDF, setIsExportingPDF] = useState(false);


  useEffect(() => {
    if (!isYamlValid || !yamlData || isIndexing) return;

    const timerId = setTimeout(() => {
      try {
        const newYamlString = (window as any).jsyaml.dump(yamlData);
        setYamlString(newYamlString);
      } catch (e) {
        console.error("Error dumping YAML", e);
      }
    }, 100); 

    return () => clearTimeout(timerId);
  }, [yamlData, isYamlValid, isIndexing]);

  // Autonomous Memory Creation Effect
  useEffect(() => {
    if (!yamlData || isModelLoading || isIndexing || isAutoSummarizing) return;
    
    const AUTONOMOUS_MEMORY_THRESHOLD = 8; // 4 user/model turns

    const allIndexedTopicIds = new Set(
        yamlData.memory_snapshots.flatMap(s => s.topic_ids)
    );
    const unindexedTopics = yamlData.context.topics.filter(
        t => !allIndexedTopicIds.has(t.id)
    );

    // Check if any unindexed topic contains the snapshot marker (Autonomous Trigger)
    const hasExplicitSnapshot = unindexedTopics.some(
        t => t.role === 'model' && t.content.includes(SNAPSHOT_START_MARKER)
    );

    if (hasExplicitSnapshot || unindexedTopics.length >= AUTONOMOUS_MEMORY_THRESHOLD) {
        handleAutonomousMemoryCreation(unindexedTopics);
    }
  }, [yamlData, isModelLoading, isIndexing, isAutoSummarizing]);

  // --- START OF MODIFIED handleAutonomousMemoryCreation ---
  const handleAutonomousMemoryCreation = async (topicsToIndex: YamlTopic[]) => {
      setIsAutoSummarizing(true);
      let chosenSummary: string | null = null;
      let isExplicitlyProvided = false;

      // Check if Ari explicitly created a snapshot in the topics being indexed
      for (const topic of topicsToIndex) {
          if (topic.role === 'model' && topic.content.includes(SNAPSHOT_START_MARKER)) {
              const startIndex = topic.content.indexOf(SNAPSHOT_START_MARKER) + SNAPSHOT_START_MARKER.length;
              let rawSummary = topic.content.substring(startIndex);
              
              // If an end marker is present, trim it
              if (rawSummary.endsWith(SNAPSHOT_END_MARKER)) {
                  rawSummary = rawSummary.substring(0, rawSummary.length - SNAPSHOT_END_MARKER.length);
              }
              chosenSummary = rawSummary.trim(); // Trim any remaining whitespace
              isExplicitlyProvided = true;
              break; // Found an explicit summary, use this one
          }
      }

      try {
          // If no explicit snapshot was found in the chunk, then generate one autonomously
          if (!isExplicitlyProvided) {
              const chunkText = topicsToIndex.map(t => `${t.role}: ${t.content}`).join('\n');
              chosenSummary = await generateAutonomousSummary(chunkText); // Call Gemini for a system-generated summary
          }
          
          if (chosenSummary) {
              const topic_ids = topicsToIndex.map(t => t.id);
              const newSnapshot: MemorySnapshot = {
                  id: `snap_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                  summary: chosenSummary, // Use Ari's summary if found, else system's
                  topic_ids,
                  timestamp: new Date().toISOString()
              };

              setYamlData(prevData => {
                  if (!prevData) return null;
                  return {
                      ...prevData,
                      memory_snapshots: [...prevData.memory_snapshots, newSnapshot]
                  }
              });
          }
      } catch (error) {
          console.error("Autonomous memory creation failed:", error);
      } finally {
          setIsAutoSummarizing(false);
      }
  };
  // --- END OF MODIFIED handleAutonomousMemoryCreation ---


  const handleImportYaml = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const contentBuffer = e.target?.result as ArrayBuffer;
          if (!contentBuffer) {
              throw new Error("File content is empty.");
          }
          const textDecoder = new TextDecoder('utf-8');
          const content = textDecoder.decode(contentBuffer);
          
          const data = (window as any).jsyaml.load(content) as YamlData;
          // Ensure memory_snapshots is an array
          if (!data.memory_snapshots) {
            data.memory_snapshots = [];
          }
          setYamlData(data);
          setYamlString(content);
          setIsYamlValid(true);
          if (data.context?.topics) {
            const validMessages = data.context.topics
              .filter(topic => topic && (topic.role === 'user' || topic.role === 'model'))
              .map(mapYamlTopicToMessage);
            setMessages(validMessages);
          } else {
            setMessages([]);
          }
        } catch (error) {
          console.error("Failed to parse YAML file:", error);
          setIsYamlValid(false);
          alert("Error: Could not parse the YAML file.");
        }
      };
      reader.onerror = () => {
          alert("Error: Could not read the file.");
      };
      reader.readAsArrayBuffer(file);
    }
  };
  
  const handleYamlChange = (newYamlString: string) => {
    const oldMessages = messages;
    setYamlString(newYamlString);
    try {
      const data = (window as any).jsyaml.load(newYamlString) as YamlData;
      if (!data.memory_snapshots) {
        data.memory_snapshots = [];
      }
      setYamlData(data);
      setIsYamlValid(true);
      
      const newMessages = (data.context?.topics || [])
         .filter(topic => topic && (topic.role === 'user' || topic.role === 'model'))
         .map(mapYamlTopicToMessage);
      setMessages(newMessages);
      
      const lastNewMessage = newMessages.length > 0 ? newMessages[newMessages.length - 1] : null;
      const lastOldMessage = oldMessages.length > 0 ? oldMessages[oldMessages.length - 1] : null;

      if (
        lastNewMessage &&
        lastNewMessage.role === 'user' &&
        lastNewMessage.id !== lastOldMessage?.id
      ) {
        getAndStreamResponse(newMessages, { userMessageAlreadyInYaml: true });
      }

    } catch (e) {
      setIsYamlValid(false);
    }
  };

  const handleExportYaml = async () => {
    console.log("Export button clicked...");
    
    // Always try to generate fresh content from yamlData first for the most up-to-date export
    let contentToExport = "";
    try {
      if (yamlData) {
        contentToExport = (window as any).jsyaml.dump(yamlData);
      } else {
        contentToExport = yamlString;
      }
    } catch (e) {
      console.error("Error generating YAML for export:", e);
      contentToExport = yamlString; // Fallback to cached string
    }

    if (!contentToExport) {
      if (isIndexing) {
        alert("The ledger is currently being indexed. Please wait a moment and try again.");
      } else {
        alert("There is no data to export yet. Try sending a message first.");
      }
      return;
    }

    try {
      // Use a Data URL instead of a Blob URL. 
      // This is often more robust in iframes and doesn't require revoking URLs.
      // We use btoa with encodeURIComponent to handle UTF-8 characters correctly.
      const base64 = btoa(unescape(encodeURIComponent(contentToExport)));
      const url = `data:text/yaml;base64,${base64}`;
      
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `memory-ledger-${timestamp}.yaml`;
      
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = fileName;
      
      document.body.appendChild(a);
      
      console.log(`Triggering download for: ${fileName} (Data URL)`);
      a.click();
      
      // Immediate removal is safe for Data URLs
      document.body.removeChild(a);
      console.log("Export process complete.");
      
    } catch (error) {
      console.error("Export failed:", error);
      alert("Failed to export the ledger. If you are using Edge, try checking your download settings or use a different browser.");
    }
  };
  
  const handleExportPDF = async () => {
    if (!(window as any).jspdf || !(window as any).html2canvas) {
        alert('PDF export libraries are not ready. Please try again in a moment.');
        return;
    }

    const chatContainer = document.getElementById('chat-container-for-pdf');
    if (!chatContainer) {
        console.error('Chat container element not found.');
        alert('Could not find chat content to export.');
        return;
    }
    
    setIsExportingPDF(true);

    try {
        const { jsPDF } = (window as any).jspdf;
        const canvas = await (window as any).html2canvas(chatContainer, {
            scale: 2,
            backgroundColor: '#131314',
            useCORS: true,
            scrollY: -window.scrollY
        });

        const imgData = canvas.toDataURL('image/png');
        
        const pdf = new jsPDF({
            orientation: 'p',
            unit: 'pt',
            format: 'a4',
        });
        
        const pdfWidth = pdf.internal.pageSize.getWidth();
        const pdfHeight = pdf.internal.pageSize.getHeight();
        const canvasWidth = canvas.width;
        const canvasHeight = canvas.height;
        const ratio = canvasWidth / pdfWidth;
        const imgHeight = canvasHeight / ratio;
        
        let heightLeft = imgHeight;
        let position = 0;

        pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, imgHeight);
        heightLeft -= pdfHeight;

        while (heightLeft > 0) {
            position -= pdfHeight;
            pdf.addPage();
            pdf.addImage(imgData, 'PNG', 0, position, pdfWidth, imgHeight);
            heightLeft -= pdfHeight;
        }
        
        const personaName = yamlData?.persona?.name || 'AI';
        const date = new Date().toISOString().split('T')[0];
        pdf.save(`Chat with ${personaName} - ${date}.pdf`);

    } catch (error) {
        console.error("Error exporting to PDF:", error);
        alert("An error occurred while creating the PDF.");
    } finally {
        setIsExportingPDF(false);
    }
  };

  const handleSavePersona = (persona: Persona) => {
    setYamlData(prevData => {
        if (!prevData) {
            const newData = (window as any).jsyaml.load(INITIAL_YAML_STRING) as YamlData;
            newData.persona = persona;
            return newData;
        }
        return { ...prevData, persona: persona };
    });
  };

  const handleIndexLedger = async () => {
    if (!yamlData || !yamlData.context.topics || yamlData.context.topics.length === 0) {
      alert("There are no topics in the ledger to index.");
      return;
    }
    setIsIndexing(true);
    try {
        const topics = yamlData.context.topics;
        const chunks: YamlTopic[][] = [];
        const CHUNK_SIZE = 10; // 10 topics per chunk (5 user/model turns)

        for (let i = 0; i < topics.length; i += CHUNK_SIZE) {
            chunks.push(topics.slice(i, i + CHUNK_SIZE));
        }

        const newSnapshots: MemorySnapshot[] = [];
        for (const chunk of chunks) {
            // Manual indexing also checks for explicit snapshots, same as autonomous
            let chosenSummary: string | null = null;
            let isExplicitlyProvided = false;

            for (const topic of chunk) {
                if (topic.role === 'model' && topic.content.includes(SNAPSHOT_START_MARKER)) {
                    const startIndex = topic.content.indexOf(SNAPSHOT_START_MARKER) + SNAPSHOT_START_MARKER.length;
                    let rawSummary = topic.content.substring(startIndex);
                    if (rawSummary.endsWith(SNAPSHOT_END_MARKER)) {
                        rawSummary = rawSummary.substring(0, rawSummary.length - SNAPSHOT_END_MARKER.length);
                    }
                    chosenSummary = rawSummary.trim();
                    isExplicitlyProvided = true;
                    break;
                }
            }

            if (!isExplicitlyProvided) {
                const chunkText = chunk.map(t => `${t.role}: ${t.content}`).join('\n');
                chosenSummary = await generateSummary(chunkText); // Use generateSummary for manual index
            }
            
            if (chosenSummary) {
                const topic_ids = chunk.map(t => t.id);
                newSnapshots.push({
                    id: `snap_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                    summary: chosenSummary,
                    topic_ids,
                    timestamp: new Date().toISOString()
                });
            }
        }
        
        setYamlData(prevData => ({
          ...prevData!,
          memory_snapshots: newSnapshots
        }));

    } catch(error) {
        console.error("Failed to index ledger:", error);
        alert("An error occurred while indexing the ledger. Please check the console.");
    } finally {
        setIsIndexing(false);
    }
  };

  const getAndStreamResponse = async (historyWithUserPrompt: Message[], options: { userMessageAlreadyInYaml: boolean }) => {
    setIsModelLoading(true);
    const modelResponseMessageId = `msg_model_${Date.now() + 1}`;
    let finalModelMessage: Message | null = null;
    const lastUserMessage = historyWithUserPrompt[historyWithUserPrompt.length - 1];

    let retrievedContext: string | null = null;
    if (yamlData && yamlData.memory_snapshots.length > 0) {
        const relevantSnapshotIds = await findRelevantMemory(lastUserMessage.text, yamlData.memory_snapshots);
        if (relevantSnapshotIds) {
            const relevantTopics = yamlData.context.topics.filter(topic => 
                relevantSnapshotIds.some(snapId => 
                    yamlData.memory_snapshots.find(s => s.id === snapId)?.topic_ids.includes(topic.id)
                )
            );
            retrievedContext = relevantTopics.map(t => `${t.role}: ${t.content}`).join('\n\n');
        }
    }

    try {
      const chat: Chat = startChat(yamlData, historyWithUserPrompt.slice(-10), chatMode === 'web' ? 'web' : 'ask', retrievedContext);
      
      const modelResponseMessage: Message = { id: modelResponseMessageId, role: 'model', text: '' };
      setMessages(prev => [...prev, modelResponseMessage]);
      const stream = await sendMessageStream(chat, lastUserMessage);
      
      let finalModelText = '';
      let groundingMetadata: any = null;
      for await (const chunk of stream) {
        const chunkText = chunk.text;
        finalModelText += chunkText;

        if (chunk.candidates?.[0]?.groundingMetadata) {
            groundingMetadata = chunk.candidates[0].groundingMetadata;
        }

        setMessages(prev =>
          prev.map(msg =>
            msg.id === modelResponseMessage.id ? { ...msg, text: finalModelText } : msg
          )
        );
      }
      finalModelMessage = { ...modelResponseMessage, text: finalModelText };

      if (groundingMetadata?.groundingChunks) {
        const citations = groundingMetadata.groundingChunks
            .map((chunk: any) => chunk.web || chunk.maps)
            .filter(Boolean)
            .map((source: any) => ({ uri: source.uri, title: source.title }))
            .filter((cite: any, index: number, self: any[]) => 
                self.findIndex(c => c.uri === cite.uri) === index);

        if (citations.length > 0) {
            finalModelMessage.citations = citations;
            setMessages(prev =>
              prev.map(msg =>
                msg.id === modelResponseMessage.id ? { ...msg, text: finalModelText, citations } : msg
              )
            );
        }
      }

    } catch (error) {
      console.error("Error in getAndStreamResponse:", error);
      let errorText = 'Sorry, I encountered an error. Please try again.';
      const errorString = String(error);
      if (/quota|RESOURCE_EXHAUSTED|429/i.test(errorString)) {
        errorText = "It looks like you've exceeded your API usage quota. Please check your plan and billing details with Google AI and try again later.";
      }
      finalModelMessage = { id: modelResponseMessageId, role: 'model', text: errorText };
      setMessages(prev => {
        const otherMessages = prev.filter(m => m.id !== modelResponseMessageId);
        return [...otherMessages, finalModelMessage!];
      });
    } finally {
      setIsModelLoading(false);
      if (finalModelMessage) {
        if (options.userMessageAlreadyInYaml) {
          updateYamlWithModelResponse(finalModelMessage);
        } else {
          updateYamlWithConversation(lastUserMessage, finalModelMessage);
        }
      }
    }
  };

  const handleSendMessage = async (text: string, attachments: Attachment[]) => {
    if (!text.trim() && attachments.length === 0 && (chatMode === 'ask' || chatMode === 'web')) return;
    if (!text.trim() && chatMode === 'imagine') return;

    const newUserMessage: Message = {
      id: `msg_user_${Date.now()}`,
      role: 'user',
      text: text,
      attachments: attachments,
    };

    setMessages(prev => [...prev, newUserMessage]);
    
    if (chatMode === 'imagine') {
      setIsModelLoading(true);
      const modelResponseMessageId = `msg_model_${Date.now() + 1}`;
      let finalModelMessage: Message | null = null;
      try {
        const base64Image = await generateImage(text);
        finalModelMessage = {
          id: modelResponseMessageId,
          role: 'model',
          text: '',
          attachments: [{
            name: `${text.slice(0, 30).trim().replace(/\s/g, '_')}.png`,
            type: 'image',
            content: base64Image,
            mimeType: 'image/png',
          }],
        };
        setMessages(prev => [...prev, finalModelMessage!]);
      } catch (error) {
        console.error("Error in handleSendMessage (imagine):", error);
        let errorText = 'Sorry, I failed to create the image. Please try again.';
        const errorString = String(error);
        if (/quota|RESOURCE_EXHAUSTED|429/i.test(errorString)) {
          errorText = "It looks like you've exceeded your API usage quota. Please check your plan and billing details with Google AI and try again later.";
        }
        finalModelMessage = { id: modelResponseMessageId, role: 'model', text: errorText };
        setMessages(prev => {
          const otherMessages = prev.filter(m => m.id !== modelResponseMessageId);
          return [...otherMessages, finalModelMessage!];
        });
      } finally {
        setIsModelLoading(false);
        if (finalModelMessage) {
          updateYamlWithConversation(newUserMessage, finalModelMessage);
        }
      }
    } else {
      const fullHistory = [...messages, newUserMessage];
      getAndStreamResponse(fullHistory, { userMessageAlreadyInYaml: false });
    }
  };
  
  const updateYamlWithConversation = (userMessage: Message, modelMessage: Message) => {
     setYamlData(prevData => {
        if (!prevData) return null;
        
        const newUserTopic: YamlTopic = {
          id: userMessage.id,
          role: 'user',
          content: userMessage.text,
          attachments: userMessage.attachments,
          timestamp: new Date().toISOString(),
        };

        const newModelTopic: YamlTopic = {
          id: modelMessage.id,
          role: 'model',
          content: modelMessage.text,
          attachments: modelMessage.attachments,
          citations: modelMessage.citations,
          timestamp: new Date().toISOString(),
        };

        const updatedTopics = [...(prevData.context.topics || []), newUserTopic, newModelTopic];
        
        return {
          ...prevData,
          context: {
            ...prevData.context,
            topics: updatedTopics,
          }
        };
      });
  };
  
  const updateYamlWithModelResponse = (modelMessage: Message) => {
     setYamlData(prevData => {
        if (!prevData) return null;
        
        const newModelTopic: YamlTopic = {
          id: modelMessage.id,
          role: 'model',
          content: modelMessage.text,
          attachments: modelMessage.attachments,
          citations: modelMessage.citations,
          timestamp: new Date().toISOString(),
        };
        
        const updatedTopics = [...(prevData.context.topics || []), newModelTopic];
        
        return {
          ...prevData,
          context: {
            ...prevData.context,
            topics: updatedTopics,
          }
        };
      });
  };

  const SidebarContent = () => (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 p-2">
        <div className="flex items-center bg-[#1e1f20] rounded-full p-1 text-sm font-medium">
           <button 
             onClick={() => setSidebarTab('ledger')}
             className={`flex-1 flex items-center justify-center gap-2 rounded-full px-3 py-1.5 transition-colors duration-200 ${sidebarTab === 'ledger' ? 'bg-[#2d2e30] text-white' : 'text-gray-400 hover:text-white'}`}
           >
              <LedgerIcon className="w-5 h-5" />
              <span>Ledger</span>
           </button>
           <button 
             onClick={() => setSidebarTab('memory')}
             className={`flex-1 flex items-center justify-center gap-2 rounded-full px-3 py-1.5 transition-colors duration-200 ${sidebarTab === 'memory' ? 'bg-[#2d2e30] text-white' : 'text-gray-400 hover:text-white'}`}
           >
              <MemoryIcon className="w-5 h-5" />
              <span>Memory</span>
           </button>
        </div>
      </div>
      <div className="flex-grow min-h-0">
          {sidebarTab === 'ledger' ? (
              <YamlEditor 
                yamlString={yamlString}
                onImport={handleImportYaml}
                onExport={handleExportYaml}
                onYamlChange={handleYamlChange}
                isValid={isYamlValid}
              />
          ) : (
              <MemorySnapshots
                  snapshots={yamlData?.memory_snapshots || []}
                  onIndex={handleIndexLedger}
                  isIndexing={isIndexing}
              />
          )}
      </div>
    </div>
  );

  return (
    <div className="bg-[#131314] text-gray-200 h-screen w-screen flex font-sans overflow-hidden">
      <aside className={`flex-shrink-0 bg-gray-900/70 backdrop-blur-sm transition-all duration-300 ease-in-out ${isSidebarOpen ? 'w-96' : 'w-0' } overflow-hidden`}>
          <SidebarContent />
      </aside>

      <div className="flex-grow flex flex-col h-screen min-w-0">
        <Header 
          onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} 
          chatMode={chatMode}
          onModeChange={setChatMode}
          onOpenPersonaEditor={() => setIsPersonaEditorOpen(true)}
          onExportPDF={handleExportPDF}
          isExportingPDF={isExportingPDF}
          messagesCount={messages.length}
        />
        <main className="flex-grow flex flex-col min-h-0">
          {messages.length === 0 && (chatMode === 'ask' || chatMode === 'web') ? (
            <WelcomeScreen onModeChange={setChatMode} />
          ) : (
            <ChatInterface 
              messages={messages} 
              isModelLoading={isModelLoading}
            />
          )}
        </main>
        <ChatInput 
          isModelLoading={isModelLoading}
          onSendMessage={handleSendMessage} 
          chatMode={chatMode}
          onModeChange={setChatMode}
        />
      </div>

      <PersonaEditor
        isOpen={isPersonaEditorOpen}
        onClose={() => setIsPersonaEditorOpen(false)}
        onSave={handleSavePersona}
        currentPersona={yamlData?.persona || { name: 'Gemini', system_instruction: 'You are a helpful AI assistant.' }}
      />
    </div>
  );
};

export default App;