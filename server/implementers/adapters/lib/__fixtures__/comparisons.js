/**
 * Comparison Data for "[X] vs [Y]" pages
 * Captures comparison search queries for SEO
 */

export default [
  {
    id: "zunkiree-vs-algolia",
    title: "Zunkiree Search vs Algolia",
    description: "Compare Zunkiree Search and Algolia for your search needs. See how AI-native search differs from traditional search-as-a-service.",
    competitor: {
      name: "Algolia",
      logo: "/assets/images/logos/algolia.svg",
      description: "Search-as-a-service platform with keyword-based instant search",
      strengths: [
        "Fast keyword search",
        "Extensive documentation",
        "Large ecosystem of integrations",
        "Typo tolerance"
      ],
      weaknesses: [
        "Keyword-based, not semantic",
        "Usage-based pricing can be expensive",
        "Limited AI capabilities",
        "Returns links, not answers"
      ]
    },
    zunkiree: {
      strengths: [
        "AI-native semantic understanding",
        "Direct answers, not just links",
        "RAG-powered knowledge retrieval",
        "Conversational follow-up queries",
        "Predictable pricing"
      ]
    },
    comparison: [
      { feature: "Search Type", zunkiree: "Semantic + AI", competitor: "Keyword + Typo tolerance" },
      { feature: "Response Format", zunkiree: "Direct answers with sources", competitor: "Ranked list of results" },
      { feature: "Natural Language", zunkiree: "Full NLU support", competitor: "Limited query understanding" },
      { feature: "Follow-up Questions", zunkiree: "Conversational context", competitor: "Each query independent" },
      { feature: "Setup Complexity", zunkiree: "Simple embed or API", competitor: "Index configuration required" },
      { feature: "AI Integration", zunkiree: "Built-in RAG & LLM", competitor: "Requires separate AI layer" },
      { feature: "Pricing Model", zunkiree: "Flat monthly rate", competitor: "Per-search + per-record" }
    ],
    bestFor: {
      zunkiree: "Businesses wanting AI-powered customer support, knowledge bases, and conversational search experiences.",
      competitor: "E-commerce and media sites needing fast, traditional keyword search with autocomplete."
    },
    verdict: "Choose Zunkiree Search if you want AI that understands questions and provides direct answers. Choose Algolia if you need traditional keyword search for product catalogs or content libraries."
  },
  {
    id: "zunkiree-vs-elasticsearch",
    title: "Zunkiree Search vs Elasticsearch",
    description: "Compare Zunkiree Search and Elasticsearch. See when managed AI search beats self-hosted infrastructure.",
    competitor: {
      name: "Elasticsearch",
      logo: "/assets/images/logos/elasticsearch.svg",
      description: "Open-source distributed search and analytics engine",
      strengths: [
        "Powerful full-text search",
        "Highly customizable",
        "Self-hosted control",
        "Large community"
      ],
      weaknesses: [
        "Complex to operate and scale",
        "Requires DevOps expertise",
        "No built-in AI/LLM support",
        "Infrastructure costs add up"
      ]
    },
    zunkiree: {
      strengths: [
        "Zero infrastructure management",
        "AI-native from day one",
        "Answers, not just search results",
        "Quick implementation",
        "Predictable costs"
      ]
    },
    comparison: [
      { feature: "Deployment", zunkiree: "Fully managed SaaS", competitor: "Self-hosted or Elastic Cloud" },
      { feature: "AI Capabilities", zunkiree: "Built-in LLM + RAG", competitor: "Requires custom integration" },
      { feature: "Setup Time", zunkiree: "Hours", competitor: "Days to weeks" },
      { feature: "Maintenance", zunkiree: "Zero ops required", competitor: "Ongoing cluster management" },
      { feature: "Scaling", zunkiree: "Automatic", competitor: "Manual cluster scaling" },
      { feature: "Query Language", zunkiree: "Natural language", competitor: "Query DSL (JSON)" },
      { feature: "Total Cost", zunkiree: "Predictable monthly", competitor: "Infra + ops + engineering" }
    ],
    bestFor: {
      zunkiree: "Teams wanting AI search without infrastructure complexity. Customer support, internal tools, and knowledge management.",
      competitor: "Engineering teams with DevOps resources who need full control over search infrastructure and complex custom queries."
    },
    verdict: "Choose Zunkiree Search for AI-powered search without the operational burden. Choose Elasticsearch if you have dedicated DevOps resources and need complete infrastructure control."
  },
  {
    id: "zunkiree-vs-typesense",
    title: "Zunkiree Search vs Typesense",
    description: "Compare Zunkiree Search and Typesense. See how AI-native search compares to open-source instant search.",
    competitor: {
      name: "Typesense",
      logo: "/assets/images/logos/typesense.svg",
      description: "Open-source, typo-tolerant search engine alternative to Algolia",
      strengths: [
        "Open-source and self-hostable",
        "Fast typo-tolerant search",
        "Simple to set up",
        "Cost-effective"
      ],
      weaknesses: [
        "Keyword-based, limited semantics",
        "No built-in AI features",
        "Self-hosting requires ops",
        "Returns links, not answers"
      ]
    },
    zunkiree: {
      strengths: [
        "Semantic understanding",
        "AI-generated answers",
        "Zero infrastructure",
        "Conversational search",
        "Enterprise-ready"
      ]
    },
    comparison: [
      { feature: "Search Approach", zunkiree: "Semantic + AI", competitor: "Keyword + typo tolerance" },
      { feature: "Hosting", zunkiree: "Fully managed", competitor: "Self-hosted or cloud" },
      { feature: "AI Features", zunkiree: "Native LLM integration", competitor: "None built-in" },
      { feature: "Response Type", zunkiree: "Answers with citations", competitor: "Ranked results" },
      { feature: "Natural Language", zunkiree: "Full support", competitor: "Basic query parsing" },
      { feature: "Enterprise Features", zunkiree: "SSO, analytics, API", competitor: "Basic analytics" },
      { feature: "Open Source", zunkiree: "No", competitor: "Yes (GPL-3.0)" }
    ],
    bestFor: {
      zunkiree: "Businesses wanting intelligent search that understands intent and provides direct answers to customer questions.",
      competitor: "Developers who want a self-hosted, open-source alternative to Algolia for traditional search."
    },
    verdict: "Choose Zunkiree Search if you want AI that provides answers, not just results. Choose Typesense if you want an open-source, self-hosted solution for traditional keyword search."
  },
  {
    id: "agentic-commerce-vs-traditional-ecommerce",
    title: "Agentic Commerce vs Traditional Ecommerce",
    description: "Compare agentic commerce with traditional ecommerce. See how AI agents transform online shopping from self-service browsing to autonomous purchasing.",
    competitor: {
      name: "Traditional Ecommerce",
      logo: "/assets/images/logos/ecommerce-icon.svg",
      description: "Standard online shopping with manual browsing, comparison, and checkout",
      strengths: [
        "Familiar user experience",
        "Full customer control over decisions",
        "Established platforms (Shopify, WooCommerce)",
        "Wide payment gateway support",
        "No AI dependency"
      ],
      weaknesses: [
        "High cart abandonment (70%+)",
        "Decision fatigue for customers",
        "Manual comparison is time-consuming",
        "Limited personalization",
        "Reactive customer support only"
      ]
    },
    zunkiree: {
      name: "Agentic Commerce",
      strengths: [
        "AI handles entire buying journey",
        "Natural language product discovery",
        "Autonomous cross-platform comparison",
        "Proactive support and recommendations",
        "Reduced cart abandonment",
        "24/7 intelligent assistance"
      ]
    },
    comparison: [
      { feature: "Product Discovery", zunkiree: "Conversational: 'Find me a laptop for coding under NPR 150k'", competitor: "Browse categories, filters, search keywords" },
      { feature: "Comparison Shopping", zunkiree: "AI compares across platforms automatically", competitor: "Manual tab-by-tab comparison" },
      { feature: "Decision Making", zunkiree: "AI recommends based on preferences", competitor: "Customer analyzes all options alone" },
      { feature: "Checkout Process", zunkiree: "Agent completes purchase autonomously", competitor: "Manual form filling and payment" },
      { feature: "Personalization", zunkiree: "Context-aware, learns preferences", competitor: "Rule-based recommendations" },
      { feature: "Customer Support", zunkiree: "Proactive AI assistance throughout", competitor: "Reactive helpdesk after issues" },
      { feature: "Cart Abandonment", zunkiree: "Significantly reduced", competitor: "~70% average abandonment rate" },
      { feature: "Multi-platform", zunkiree: "Searches Daraz, local stores, brands", competitor: "Limited to single storefront" },
      { feature: "Payment Integration", zunkiree: "Intelligent routing (eSewa, Khalti, cards)", competitor: "Customer selects payment method" },
      { feature: "Language Support", zunkiree: "Natural Nepali + English queries", competitor: "Interface language only" }
    ],
    bestFor: {
      zunkiree: "Businesses wanting to reduce friction, increase conversions, and provide AI-powered shopping experiences. Ideal for Nepal market with eSewa/Khalti integration.",
      competitor: "Businesses with simple product catalogs where customers prefer full control over browsing and purchasing decisions."
    },
    verdict: "Choose agentic commerce if you want AI to handle the buying journey, reduce cart abandonment, and provide personalized service at scale. Choose traditional ecommerce if your customers prefer complete manual control and you have a straightforward product catalog.",
    ctaProduct: "ai-commerce-agent",
    ctaService: "ai-ecommerce"
  }
];
