/**
 * AI Glossary Terms
 * 20 definitions for AEO - captures "What is X?" queries
 */

export default [
  {
    id: "agentic-commerce",
    term: "Agentic Commerce",
    shortDef: "AI-powered ecommerce where autonomous agents handle the entire buying journey from discovery to checkout.",
    definition: "Agentic commerce is an emerging ecommerce paradigm where AI agents autonomously handle shopping tasks on behalf of customers. Unlike traditional online shopping that requires manual browsing, comparison, and checkout, agentic commerce systems understand customer intent through natural language, search across multiple platforms, compare options, and execute purchases automatically. These AI agents integrate with payment gateways, track orders, and handle support—transforming ecommerce from a self-service experience to an AI-assisted one. In Nepal, agentic commerce platforms integrate with eSewa, Khalti, and local marketplaces to provide seamless autonomous shopping.",
    relatedService: "ai-ecommerce",
    category: "AI Commerce"
  },
  {
    id: "rag",
    term: "RAG (Retrieval-Augmented Generation)",
    shortDef: "An AI architecture that combines information retrieval with text generation to produce accurate, context-aware responses.",
    definition: "Retrieval-Augmented Generation (RAG) is an AI architecture pattern that enhances large language models by connecting them to external knowledge sources. When a user asks a question, the system first retrieves relevant documents from a knowledge base, then uses that context to generate an accurate response. RAG solves the hallucination problem common in pure LLMs by grounding responses in verified information. This approach is widely used for enterprise chatbots, document Q&A systems, and customer support automation.",
    relatedService: "ai-development",
    category: "AI Architecture"
  },
  {
    id: "llm",
    term: "LLM (Large Language Model)",
    shortDef: "An AI model trained on massive text datasets that can understand and generate human-like text.",
    definition: "A Large Language Model (LLM) is a type of artificial intelligence trained on billions of words from books, websites, and documents. LLMs like GPT-4, Claude, and Llama can understand context, answer questions, write content, and assist with complex tasks. They work by predicting the most likely next word in a sequence, but at scale, this creates emergent capabilities like reasoning and code generation. Businesses use LLMs for customer support, content creation, code assistance, and process automation.",
    relatedService: "ai-development",
    category: "AI Models"
  },
  {
    id: "vector-database",
    term: "Vector Database",
    shortDef: "A database optimized for storing and searching high-dimensional vectors, enabling semantic search and AI applications.",
    definition: "A vector database is a specialized database designed to store and query high-dimensional vectors (embeddings). Unlike traditional databases that match exact keywords, vector databases find semantically similar content. When text is converted to vectors using embedding models, similar concepts cluster together in vector space. This enables semantic search, recommendation systems, and RAG applications. Popular vector databases include Pinecone, Weaviate, Qdrant, and pgvector for PostgreSQL.",
    relatedService: "data-systems",
    category: "Data Infrastructure"
  },
  {
    id: "ai-agent",
    term: "AI Agent",
    shortDef: "An autonomous AI system that can perceive its environment, make decisions, and take actions to achieve goals.",
    definition: "An AI agent is a software system that uses artificial intelligence to autonomously perform tasks on behalf of users. Unlike simple chatbots that only respond to queries, AI agents can plan multi-step workflows, use tools (APIs, databases, web browsers), and adapt their approach based on results. Examples include coding assistants that can write and test code, research agents that gather information from multiple sources, and customer service agents that can process refunds or schedule appointments.",
    relatedService: "ai-development",
    category: "AI Architecture"
  },
  {
    id: "embeddings",
    term: "Embeddings",
    shortDef: "Numerical representations of text, images, or other data that capture semantic meaning in a format AI can process.",
    definition: "Embeddings are dense numerical vectors that represent the meaning of text, images, or other data in a format that AI systems can process. Created by specialized models like OpenAI's text-embedding-ada-002, embeddings capture semantic relationships—similar concepts have similar vector representations. A 1,536-dimensional embedding can encode nuanced meaning, enabling applications like semantic search, clustering, and recommendation systems. Embeddings are fundamental to RAG systems, where they enable finding relevant documents based on meaning rather than keywords.",
    relatedService: "ai-development",
    category: "AI Fundamentals"
  },
  {
    id: "semantic-search",
    term: "Semantic Search",
    shortDef: "Search technology that understands the meaning and intent behind queries, not just keyword matching.",
    definition: "Semantic search is a search approach that understands the meaning and intent behind user queries rather than just matching keywords. Using embeddings and natural language processing, semantic search can find relevant results even when the exact words don't match. For example, a search for 'affordable housing' would also return results about 'low-cost apartments' or 'budget-friendly rentals.' This technology powers modern search experiences in enterprise knowledge bases, e-commerce, and customer support systems.",
    relatedService: "ai-customer-experience",
    category: "Search Technology"
  },
  {
    id: "ai-native-search",
    term: "AI-Native Search",
    shortDef: "Search platforms built from the ground up with AI, delivering direct answers instead of links.",
    definition: "AI-native search refers to search platforms designed with artificial intelligence as the core architecture, not an afterthought. Unlike traditional search that returns a list of links, AI-native search understands natural language queries and provides direct answers synthesized from your content. These systems combine semantic search, RAG, and conversational AI to create search experiences that feel like talking to an expert. Zunkiree Search is an example of AI-native search built for businesses.",
    relatedService: "ai-customer-experience",
    category: "Search Technology"
  },
  {
    id: "fine-tuning",
    term: "Fine-tuning",
    shortDef: "The process of further training an AI model on specific data to improve performance for particular tasks.",
    definition: "Fine-tuning is the process of taking a pre-trained AI model and training it further on domain-specific data. This customization improves the model's performance for particular tasks, industries, or writing styles. For example, fine-tuning GPT on legal documents creates a model better at legal analysis, while fine-tuning on customer support conversations improves response quality. Fine-tuning requires less data and compute than training from scratch while achieving excellent results for specific use cases.",
    relatedService: "ai-development",
    category: "AI Training"
  },
  {
    id: "prompt-engineering",
    term: "Prompt Engineering",
    shortDef: "The practice of designing effective instructions for AI models to produce desired outputs.",
    definition: "Prompt engineering is the practice of crafting effective instructions (prompts) for AI models to produce desired outputs. Good prompts include clear context, specific requirements, examples of desired output, and appropriate constraints. Techniques include few-shot prompting (providing examples), chain-of-thought prompting (asking the model to reason step-by-step), and role-based prompting (asking the AI to act as an expert). Effective prompt engineering can dramatically improve AI output quality without model changes.",
    relatedService: "ai-development",
    category: "AI Practice"
  },
  {
    id: "aeo",
    term: "AEO (AI Engine Optimization)",
    shortDef: "Optimizing content to be discovered and cited by AI assistants like ChatGPT, Perplexity, and Google AI.",
    definition: "AI Engine Optimization (AEO) is the practice of optimizing content to be discovered, understood, and cited by AI assistants and search engines. As users increasingly get answers from ChatGPT, Perplexity, Google AI Overviews, and Claude, businesses need their content to be selected as authoritative sources. AEO techniques include writing self-contained definitions, using clear structure, providing statistics with sources, and creating FAQ content that matches how people ask questions.",
    relatedService: "aeo-seo",
    category: "Marketing"
  },
  {
    id: "nlp",
    term: "Natural Language Processing (NLP)",
    shortDef: "The field of AI that enables computers to understand, interpret, and generate human language.",
    definition: "Natural Language Processing (NLP) is a branch of artificial intelligence focused on enabling computers to understand and work with human language. NLP powers applications like chatbots, sentiment analysis, translation, text summarization, and voice assistants. Modern NLP uses transformer architectures and large language models to achieve human-level performance on many tasks. Key capabilities include named entity recognition, intent classification, semantic understanding, and text generation.",
    relatedService: "ai-development",
    category: "AI Fundamentals"
  },
  {
    id: "knowledge-graph",
    term: "Knowledge Graph",
    shortDef: "A structured representation of real-world entities and their relationships, enabling intelligent information retrieval.",
    definition: "A knowledge graph is a structured database that represents real-world entities (people, places, concepts) and the relationships between them. Unlike traditional databases with rigid tables, knowledge graphs model information as interconnected nodes and edges. This structure enables intelligent querying, reasoning, and discovery. Google's Knowledge Graph powers rich search results, while enterprise knowledge graphs help organizations connect scattered information across systems for better decision-making and AI applications.",
    relatedService: "data-systems",
    category: "Data Infrastructure"
  },
  {
    id: "multi-tenant-saas",
    term: "Multi-tenant SaaS",
    shortDef: "Software architecture where a single application serves multiple customers while keeping their data separate.",
    definition: "Multi-tenant Software-as-a-Service (SaaS) is an architecture where one application instance serves multiple customers (tenants) while keeping their data logically separated. Each tenant gets their own isolated environment within the shared infrastructure, reducing costs and simplifying maintenance. Key considerations include data isolation, customization options, and scalable resource allocation. This model powers most modern SaaS products, from CRMs to project management tools.",
    relatedService: "saas-development",
    category: "Software Architecture"
  },
  {
    id: "ai-orchestration",
    term: "AI Orchestration",
    shortDef: "Coordinating multiple AI models, tools, and services to work together in complex workflows.",
    definition: "AI orchestration refers to coordinating multiple AI models, tools, and external services to work together in complex workflows. Rather than a single model handling everything, orchestration systems route tasks to specialized components—one model for understanding intent, another for retrieval, another for generation. Frameworks like LangChain and LlamaIndex enable orchestration patterns. This approach improves reliability, enables complex multi-step reasoning, and allows mixing different AI capabilities.",
    relatedService: "ai-development",
    category: "AI Architecture"
  },
  {
    id: "retrieval-system",
    term: "Retrieval System",
    shortDef: "A system that finds and returns relevant information from a knowledge base in response to queries.",
    definition: "A retrieval system is a component that finds and returns relevant information from a knowledge base in response to user queries. In AI applications, retrieval systems combine multiple techniques: keyword search (BM25), semantic search (vector similarity), and hybrid approaches. The retrieval quality directly impacts RAG system performance—if irrelevant documents are retrieved, the AI will generate poor responses. Modern retrieval systems use reranking, query expansion, and metadata filtering to improve accuracy.",
    relatedService: "ai-development",
    category: "AI Architecture"
  },
  {
    id: "inference",
    term: "Inference",
    shortDef: "The process of running a trained AI model to generate predictions or outputs from new input data.",
    definition: "Inference is the process of using a trained AI model to generate predictions or outputs from new input data. While training teaches the model, inference is when the model applies what it learned. Inference latency (speed) and cost are critical considerations for production AI systems. Options include cloud APIs (OpenAI, Anthropic), self-hosted models, and edge deployment. Optimization techniques like quantization and batching reduce inference costs while maintaining quality.",
    relatedService: "ai-development",
    category: "AI Operations"
  },
  {
    id: "token",
    term: "Token",
    shortDef: "The basic unit of text that AI models process, roughly equivalent to 4 characters or 0.75 words.",
    definition: "A token is the basic unit of text that AI language models process. Tokenization breaks text into subword units that the model can understand. In English, one token roughly equals 4 characters or 0.75 words. 'Artificial intelligence' might be 3 tokens: 'Art', 'ificial', 'intelligence'. Token counts matter because they determine costs (APIs charge per token) and context limits. Understanding tokenization helps optimize prompts and estimate API costs.",
    relatedService: "ai-development",
    category: "AI Fundamentals"
  },
  {
    id: "context-window",
    term: "Context Window",
    shortDef: "The maximum amount of text an AI model can process in a single request, measured in tokens.",
    definition: "A context window is the maximum amount of text (measured in tokens) that an AI model can process in a single request. GPT-4 Turbo has a 128K token context window (roughly 100,000 words), while Claude offers up to 200K tokens. Larger context windows enable processing longer documents, maintaining conversation history, and providing more context for accurate responses. Context window size is a key differentiator between AI models and affects architecture decisions for RAG systems.",
    relatedService: "ai-development",
    category: "AI Fundamentals"
  },
  {
    id: "zero-shot-learning",
    term: "Zero-shot Learning",
    shortDef: "An AI model's ability to perform tasks it wasn't explicitly trained on, without examples.",
    definition: "Zero-shot learning refers to an AI model's ability to perform tasks it wasn't explicitly trained on, without being given examples. Modern large language models exhibit strong zero-shot capabilities—you can ask them to translate, summarize, or classify text without fine-tuning. This contrasts with traditional machine learning, which required task-specific training data. Zero-shot capability makes LLMs versatile tools, though performance often improves with examples (few-shot) or fine-tuning.",
    relatedService: "ai-development",
    category: "AI Training"
  },
  {
    id: "few-shot-learning",
    term: "Few-shot Learning",
    shortDef: "Teaching an AI model new tasks by providing just a few examples in the prompt.",
    definition: "Few-shot learning is a technique where an AI model learns to perform a task from just a few examples provided in the prompt. Instead of fine-tuning on thousands of examples, you include 2-5 demonstrations of the desired input-output pattern. The model generalizes from these examples to handle new inputs. Few-shot prompting is more reliable than zero-shot for complex tasks and more practical than fine-tuning when data is limited or tasks change frequently.",
    relatedService: "ai-development",
    category: "AI Training"
  }
];
