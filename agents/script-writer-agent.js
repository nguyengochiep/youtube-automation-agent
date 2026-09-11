const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');

// Measured narration pace, used to turn "8-12 minutes" into a word budget the
// model can actually aim at.
const NARRATION_WORDS_PER_MINUTE = 165;

class ScriptWriterAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ScriptWriter');
    this.templates = this.loadTemplates();
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
  }

  async initialize() {
    this.logger.info('Initializing Script Writer Agent...');
    return true;
  }

  loadTemplates() {
    return {
      tutorial: {
        structure: ['hook', 'introduction', 'problem', 'solution_steps', 'demonstration', 'recap', 'cta'],
        tone: 'educational',
        pacing: 'moderate'
      },
      explainer: {
        structure: ['hook', 'question', 'background', 'explanation', 'examples', 'implications', 'summary', 'cta'],
        tone: 'informative',
        pacing: 'steady'
      },
      list: {
        structure: ['hook', 'introduction', 'list_items', 'bonus_item', 'summary', 'cta'],
        tone: 'engaging',
        pacing: 'quick'
      },
      review: {
        structure: ['hook', 'introduction', 'overview', 'pros', 'cons', 'comparison', 'verdict', 'cta'],
        tone: 'analytical',
        pacing: 'detailed'
      },
      story: {
        structure: ['hook', 'setup', 'conflict', 'journey', 'climax', 'resolution', 'lesson', 'cta'],
        tone: 'narrative',
        pacing: 'dynamic'
      }
    };
  }

  async generateScript(strategy) {
    try {
      this.logger.info(`Generating script for: ${strategy.topic}`);
      
      const template = this.templates[strategy.contentType.toLowerCase()] || this.templates.explainer;
      const aiScript = await this.generateScriptWithAI(strategy, template);
      if (aiScript) {
        aiScript.fullScript = this.formatFullScript(aiScript);
        await this.db.saveScript(aiScript);
        this.logger.info(`Script generated with AI provider: ${aiScript.title}`);
        return aiScript;
      }
      
      this.logger.info('Using template script generation');
      // Generate script components
      const hook = await this.generateHook(strategy);
      const introduction = await this.generateIntroduction(strategy);
      const mainContent = await this.generateMainContent(strategy, template);
      const conclusion = await this.generateConclusion(strategy);
      const cta = await this.generateCTA(strategy);

      // Assemble complete script
      const script = {
        title: await this.generateTitle(strategy),
        hook,
        introduction,
        mainContent,
        conclusion,
        callToAction: cta,
        duration: this.estimateDuration(mainContent),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords,
        claims: [],
        metadata: {
          strategy: strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0'
        }
      };

      // Format for readability
      script.fullScript = this.formatFullScript(script);
      
      // Save to database
      await this.db.saveScript(script);
      
      this.logger.info(`Script generated: ${script.title}`);
      return script;
    } catch (error) {
      this.logger.error('Failed to generate script:', error);
      throw error;
    }
  }

  /**
   * Kept apart from the request so the wording can be asserted in tests. The
   * shape example carries two sections of different lengths on purpose: a
   * single example with one duration anchored every section the model wrote to
   * that number, and the first published video came back as six identical
   * sixty-second blocks with three bullets each.
   */
  /**
   * The prompt asked for "8-12 minutes" and video two came back at three and a
   * half. The model was never told how many words that is, and 1800 output
   * tokens could not hold it anyway once the JSON and the claims list were paid
   * for. The lower bound of the requested range becomes a word budget — the
   * lower bound, because every extra word is one more claim to verify — and
   * the token ceiling is sized to fit it.
   */
  targetSpokenWords(strategy = {}) {
    const text = String(strategy.requestedLength || process.env.DEFAULT_VIDEO_LENGTH || '8-12 minutes');
    const minutes = Number((text.match(/\d+(?:\.\d+)?/) || [])[0]) || 8;
    return Math.max(200, Math.round((minutes * NARRATION_WORDS_PER_MINUTE) / 50) * 50);
  }

  targetSectionCount(strategy = {}) {
    // normalizeAISections keeps at most eight.
    return Math.min(8, Math.max(3, Math.round(this.targetSpokenWords(strategy) / 180)));
  }

  scriptMaxTokens(strategy = {}) {
    // Roughly 1.4 tokens a word, plus the JSON scaffolding and the claims list.
    return Math.max(1800, Math.ceil(this.targetSpokenWords(strategy) * 1.6) + 800);
  }

  buildScriptPrompt(strategy, template) {
    return `You are writing a YouTube script plan.
Return only valid JSON with this exact shape:
{
  "title": "compelling title under 100 characters",
  "hook": "opening hook in one sentence",
  "opening": ["two or three sentences that follow the hook", "no greeting, no channel name, no restatement of the title"],
  "conclusion": ["two or three sentences that close the video", "answer the question the hook opened; no list of what was covered"],
  "sections": [
    { "title": "section title", "content": ["spoken script bullet", "another bullet"], "duration": 45 },
    { "title": "next section title", "content": ["one longer bullet"], "duration": 75 }
  ],
  "cta": "clear call to action",
  "claims": [
    { "text": "specific factual claim a reviewer must verify", "riskLevel": "standard|high", "sourceUrls": ["exact supplied source URL"] }
  ]
}

Topic: ${strategy.topic}
Style/content type: ${strategy.contentType}
Angle: ${strategy.angle}
Target audience: ${strategy.targetAudience}
Desired length: ${strategy.requestedLength || process.env.DEFAULT_VIDEO_LENGTH || '8-12 minutes'} — about ${this.targetSpokenWords(strategy)} spoken words across the hook, opening, sections and conclusion, in ${this.targetSectionCount(strategy)} sections. Fill that length with material the sources support; do not pad it
Tone: ${template.tone}
Pacing: ${template.pacing}
Brand voice: ${strategy.brandVoice || 'clear, credible, and engaging'}
Channel goal: ${strategy.channelGoal || 'help the viewer understand and act'}
Channel value proposition: ${strategy.channelValueProposition || 'give the viewer practical value'}
Editorial rationale: ${strategy.planRationale || 'fit the selected topic and audience'}
Channel constraints: ${strategy.channelConstraints || 'none beyond the factual-safety rules below'}
Preferred call to action: ${strategy.callToAction || 'invite the viewer to subscribe'}
Keywords: ${(strategy.keywords || []).join(', ')}
Research sources: ${JSON.stringify(strategy.researchSources || [])}
Avoid fabricated statistics, unsupported claims, and fake urgency. Saying that a text does not mention something is a factual claim too: never say what a source omits or lacks unless the channel constraints state it. Never claim personal experience, research effort, or credentials on the narrator's behalf. Do not open with a greeting, the channel name, "in this video", or "by the end of this video".
Let the material decide how long each section runs, between 30 and 90 seconds. A section that establishes a single fact should be short and carry one or two bullets; a section that walks through conflicting evidence should be long and carry four or five. Do not spread the content evenly, and do not cycle through a repeating pattern of lengths: the longest section should carry at least twice the material of the shortest. End each section on a sentence that opens the next question rather than one that concludes. Do not write a summary or recap section before the conclusion; a viewer who is told the video is wrapping up stops watching. Close with the conclusion lines: answer the question the hook opened, without listing what the video covered and without telling the viewer to keep learning.
List every externally verifiable factual claim in claims. Use only exact URLs from Research sources; use an empty sourceUrls array when the supplied sources do not support a claim.`;
  }

  async generateScriptWithAI(strategy, template) {
    if (!this.aiTextService.isAvailable()) {
      this.logger.info('Using template script generation because no AI text provider is configured');
      return null;
    }

    const prompt = this.buildScriptPrompt(strategy, template);

    try {
      const response = await this.aiTextService.generateText(prompt, {
        maxTokens: this.scriptMaxTokens(strategy),
        temperature: 0.7
      });
      const parsed = this.parseAIJsonResponse(response);
      const sections = this.normalizeAISections(parsed.sections, strategy);

      if (!parsed.title || !parsed.hook || sections.length === 0) {
        throw new Error('AI script response missing required fields');
      }

      this.logger.info(`Using AI script generation via ${this.aiTextService.providerName}`);
      return {
        title: String(parsed.title).slice(0, 100),
        hook: this.normalizeAIHook(parsed.hook),
        introduction: await this.generateIntroduction(strategy, parsed.opening),
        mainContent: {
          sections,
          totalDuration: this.calculateSectionsDuration(sections)
        },
        conclusion: await this.generateConclusion(strategy, parsed.conclusion),
        callToAction: this.normalizeAICTA(parsed.cta, strategy),
        duration: this.estimateDuration({ sections }),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords || [],
        claims: this.normalizeAIClaims(parsed.claims, strategy.researchSources || []),
        metadata: {
          strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0',
          generationSource: 'ai'
        }
      };
    } catch (error) {
      this.logger.warn(`AI script generation failed; using template fallback: ${error.message}`);
      return null;
    }
  }

  parseAIJsonResponse(response) {
    const text = String(response || '').trim();
    const withoutFences = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    try {
      return JSON.parse(withoutFences);
    } catch (error) {
      const match = withoutFences.match(/\{[\s\S]*\}/);
      if (!match) {
        throw error;
      }
      return JSON.parse(match[0]);
    }
  }

  normalizeAIHook(hook) {
    const text = typeof hook === 'object' && hook !== null ? hook.text : hook;
    return {
      type: 'ai',
      text: String(text).trim(),
      duration: '0:00-0:05'
    };
  }

  normalizeAISections(sections, strategy) {
    if (!Array.isArray(sections)) {
      return [];
    }

    return sections
      .slice(0, 8)
      .map((section, index) => {
        const rawContent = Array.isArray(section.content)
          ? section.content
          : [section.content || section.summary || section.description];
        const content = rawContent
          .filter(Boolean)
          .map(line => String(line).trim())
          .filter(Boolean);

        return {
          type: 'ai_generated',
          title: String(section.title || `${strategy.topic} Part ${index + 1}`).trim(),
          content,
          duration: parseInt(section.duration, 10) || 60
        };
      })
      .filter(section => section.title && section.content.length > 0);
  }

  normalizeAIClaims(claims, sources) {
    if (!Array.isArray(claims)) return [];
    const allowedUrls = new Set((sources || []).map(source => source.url));
    return claims.slice(0, 25).map(item => ({
      text: String(item?.text || item?.claim || '').trim().slice(0, 1000),
      riskLevel: item?.riskLevel === 'high' ? 'high' : 'standard',
      sourceUrls: [...new Set((Array.isArray(item?.sourceUrls) ? item.sourceUrls : [])
        .map(url => String(url))
        .filter(url => allowedUrls.has(url)))]
    })).filter(item => item.text);
  }

  /**
   * The closing used to fill all four slots whether or not it had anything to
   * put in them, which produced lines like "Share your experience with" followed
   * by the entire title — an invitation nobody can act on when the subject is a
   * fifteenth-century chronicle. Slots with nothing to say are now empty
   * strings; every consumer reads these by name, so the keys stay.
   */
  normalizeAICTA(cta, strategy) {
    const source = cta && typeof cta === 'object' ? cta : { subscribe: cta };
    return {
      type: 'call_to_action',
      subscribe: String(source.subscribe || source.text || this.defaultSubscribeLine(strategy)),
      like: String(source.like || ''),
      comment: String(source.comment || this.defaultCommentLine()),
      nextVideo: String(source.nextVideo || ''),
      duration: '15 seconds'
    };
  }

  defaultSubscribeLine(strategy) {
    const promise = String(strategy?.channelValueProposition || '').trim();
    return promise
      ? `Subscribe if that is what you want more of: ${promise}`
      : 'Subscribe if you want the next one.';
  }

  /**
   * A comment prompt has to be answerable. Asking for a correction or a missing
   * source is something a viewer of any episode can actually do, and it is the
   * one request that matches a channel built on citing its evidence.
   */
  defaultCommentLine() {
    return 'If I have missed a source or got something wrong, put it in the comments and I will read it.';
  }
  async generateTitle(strategy) {
    const templates = [
      `${strategy.angle}`,
      `${strategy.topic}: The Complete Guide`,
      `Everything You Need to Know About ${strategy.topic}`,
      `${strategy.topic} in ${new Date().getFullYear()}: What's Changed?`,
      `The Truth About ${strategy.topic} (Shocking Results)`,
      `How to Master ${strategy.topic} in 30 Days`,
      `${strategy.topic}: Beginner to Expert Guide`
    ];

    // Select based on content type
    if (strategy.contentType === 'Tutorial') {
      return `How to ${strategy.topic}: Step-by-Step Guide`;
    } else if (strategy.contentType === 'List') {
      return `Top 10 ${strategy.topic} Tips You Need to Know`;
    } else if (strategy.contentType === 'Review') {
      return `${strategy.topic} Review: Is It Worth It?`;
    }

    return templates[Math.floor(Math.random() * templates.length)];
  }

  async generateHook(strategy) {
    const hooks = [
      {
        type: 'question',
        text: `Have you ever wondered ${this.generateQuestionAbout(strategy.topic)}?`
      },
      {
        type: 'statistic',
        text: `Did you know that ${this.generateStatistic(strategy.topic)}?`
      },
      {
        type: 'statement',
        text: `${strategy.topic} is about to change everything, and here's why...`
      },
      {
        type: 'challenge',
        text: `Most people think they understand ${strategy.topic}, but they're completely wrong.`
      },
      {
        type: 'promise',
        text: `In the next few minutes, you'll learn exactly how to master ${strategy.topic}.`
      }
    ];

    const selected = hooks[Math.floor(Math.random() * hooks.length)];
    
    return {
      type: selected.type,
      text: selected.text,
      duration: '0:00-0:05'
    };
  }

  generateQuestionAbout(topic) {
    const questions = [
      `why ${topic} is becoming so important`,
      `how ${topic} actually works`,
      `what makes ${topic} different from everything else`,
      `why experts are talking about ${topic}`,
      `how ${topic} could change your life`
    ];
    
    return questions[Math.floor(Math.random() * questions.length)];
  }

  generateStatistic(topic) {
    const stats = [
      `many people are still figuring out how ${topic} works`,
      `the conversation around ${topic} keeps expanding`,
      `experts continue to debate where ${topic} is headed`,
      `people often miss the practical side of ${topic}`,
      `${topic} can be easier to approach with a clear framework`
    ];
    
    return stats[Math.floor(Math.random() * stats.length)];
  }

  /**
   * The opening is the fifteen seconds where a viewer decides to stay, and it
   * used to be spent on a greeting, a restatement of the title, and a randomly
   * chosen credential the channel had not earned. Those credentials were
   * invented outright — the same fabrication the AI prompt above forbids the
   * model from producing — so they are gone rather than reworded.
   *
   * What is left says only what the strategy actually knows: what the video
   * covers, what the viewer gets, and a source attribution that appears only
   * when the research stage supplied a real source.
   *
   * The four field names are load-bearing: production assembly, TTS text,
   * duration estimation and scene splitting all read them by name, and scripts
   * already in the database carry the same shape.
   */
  async generateIntroduction(strategy, opening = null) {
    const lines = Array.isArray(opening)
      ? opening.map(line => String(line || '').trim()).filter(Boolean)
      : [];

    if (lines.length) {
      return {
        greeting: '',
        topicIntro: lines[0],
        valueProposition: lines.slice(1).join(' '),
        credibility: this.getSourceAttribution(strategy),
        duration: '0:05-0:20'
      };
    }

    return {
      greeting: '',
      topicIntro: `${strategy.topic}.`,
      valueProposition: `Here is ${this.getValueProposition(strategy)}.`,
      credibility: this.getSourceAttribution(strategy),
      duration: '0:05-0:20'
    };
  }

  getValueProposition(strategy) {
    const propositions = {
      'Tutorial': `how to do it, step by step`,
      'Explainer': `what it is and why it matters`,
      'List': `what matters most about it`,
      'Review': `what it does well and where it falls short`,
      'Story': `how it happened`
    };

    return propositions[strategy.contentType] || `what the record actually shows`;
  }

  /**
   * Credibility is claimed only when the research stage handed over a source to
   * claim it from, and it names that source so a viewer can go and check. With
   * no source there is no sentence: an unsupported credential is worse than
   * silence, and provenance review would have to strip it out later anyway.
   */
  getSourceAttribution(strategy) {
    for (const item of strategy?.researchSources || []) {
      const name = typeof item === 'string'
        ? item
        : String(item?.publisher || item?.title || '');
      const trimmed = name.trim();
      if (trimmed && !/^https?:\/\//i.test(trimmed)) {
        return `Sources are linked in the description, starting with ${trimmed.slice(0, 120)}.`;
      }
    }
    return '';
  }

  async generateMainContent(strategy, template) {
    const sections = [];
    
    for (const section of template.structure) {
      if (!['hook', 'introduction', 'cta'].includes(section)) {
        sections.push(await this.generateSection(section, strategy));
      }
    }
    
    return {
      sections,
      totalDuration: this.calculateSectionsDuration(sections)
    };
  }

  async generateSection(sectionType, strategy) {
    const sectionGenerators = {
      problem: () => this.generateProblemSection(strategy),
      solution_steps: () => this.generateSolutionSteps(strategy),
      demonstration: () => this.generateDemonstration(strategy),
      explanation: () => this.generateExplanation(strategy),
      examples: () => this.generateExamples(strategy),
      list_items: () => this.generateListItems(strategy),
      pros: () => this.generatePros(strategy),
      cons: () => this.generateCons(strategy),
      comparison: () => this.generateComparison(strategy),
      implications: () => this.generateImplications(strategy)
    };

    const generator = sectionGenerators[sectionType];
    
    if (generator) {
      return await generator();
    }
    
    return this.generateGenericSection(sectionType, strategy);
  }

  async generateProblemSection(strategy) {
    return {
      type: 'problem',
      title: 'The Challenge',
      content: [
        `Many people struggle with ${strategy.topic}.`,
        `The main issues are:`,
        `1. Lack of clear information`,
        `2. Complexity and confusion`,
        `3. Not knowing where to start`,
        `But don't worry, we're going to solve all of these today.`
      ],
      visuals: ['Problem illustration', 'Statistics graphic'],
      duration: 30
    };
  }

  async generateSolutionSteps(strategy) {
    const steps = [];
    const numSteps = 3 + Math.floor(Math.random() * 3); // 3-5 steps
    
    for (let i = 1; i <= numSteps; i++) {
      steps.push({
        number: i,
        title: `Step ${i}: ${this.generateStepTitle(strategy.topic, i)}`,
        description: this.generateStepDescription(strategy.topic, i),
        tip: this.generateProTip(strategy.topic)
      });
    }
    
    return {
      type: 'solution_steps',
      title: 'The Solution',
      steps,
      duration: steps.length * 45
    };
  }

  generateStepTitle(topic, stepNumber) {
    const titles = [
      'Research and Preparation',
      'Setting Up the Foundation',
      'Implementation and Execution',
      'Testing and Optimization',
      'Scaling and Automation'
    ];
    
    return titles[stepNumber - 1] || `Advanced ${topic} Techniques`;
  }

  generateStepDescription(topic, _stepNumber) {
    return `This step involves understanding the key aspects of ${topic} and how to apply them effectively. Pay special attention to the details here, as they make all the difference.`;
  }

  generateProTip(_topic) {
    const tips = [
      `Pro tip: Start small and scale gradually`,
      `Remember: Consistency is more important than perfection`,
      `Quick tip: Document everything as you go`,
      `Expert advice: Focus on one aspect at a time`,
      `Insider secret: This works best when combined with regular practice`
    ];
    
    return tips[Math.floor(Math.random() * tips.length)];
  }

  async generateDemonstration(_strategy) {
    return {
      type: 'demonstration',
      title: 'Live Demo',
      content: [
        `Now let me show you exactly how this works.`,
        `[Screen recording or visual demonstration]`,
        `As you can see, the process is straightforward once you understand the basics.`,
        `The key is to follow the steps exactly as shown.`
      ],
      visuals: ['Screen recording', 'Step-by-step graphics'],
      duration: 120
    };
  }

  async generateExplanation(strategy) {
    return {
      type: 'explanation',
      title: 'Deep Dive',
      content: [
        `Let's break down ${strategy.topic} into its core components.`,
        `First, we need to understand the fundamental principles.`,
        `The science behind this is fascinating...`,
        `[Detailed explanation with visuals]`,
        `This is why ${strategy.topic} works so effectively.`
      ],
      visuals: ['Diagrams', 'Infographics', 'Charts'],
      duration: 90
    };
  }

  async generateExamples(strategy) {
    return {
      type: 'examples',
      title: 'Real-World Examples',
      content: [
        `Let's look at some real examples of ${strategy.topic} in action.`,
        `Example 1: [Specific case study]`,
        `Example 2: [Another relevant example]`,
        `Example 3: [Third compelling example]`,
        `These examples show the versatility and power of ${strategy.topic}.`
      ],
      visuals: ['Case study graphics', 'Before/after comparisons'],
      duration: 75
    };
  }

  async generateListItems(strategy) {
    const items = [];
    const numItems = 5 + Math.floor(Math.random() * 6); // 5-10 items
    
    for (let i = 1; i <= numItems; i++) {
      items.push({
        number: numItems - i + 1, // Countdown for engagement
        title: this.generateListItemTitle(strategy.topic, i),
        description: this.generateListItemDescription(strategy.topic),
        impact: this.generateImpactStatement()
      });
    }
    
    return {
      type: 'list_items',
      title: `Top ${numItems} Things About ${strategy.topic}`,
      items,
      duration: items.length * 30
    };
  }

  generateListItemTitle(topic, index) {
    const titles = [
      `The Hidden Power of ${topic}`,
      `Why ${topic} Matters More Than You Think`,
      `The Surprising Truth About ${topic}`,
      `How ${topic} Can Transform Your Approach`,
      `The ${topic} Secret Nobody Talks About`,
      `Mastering ${topic} in Record Time`,
      `The Ultimate ${topic} Hack`,
      `${topic}: The Game Changer`,
      `Breaking Down ${topic} Myths`,
      `The Future of ${topic}`
    ];
    
    return titles[index - 1] || `Advanced ${topic} Technique #${index}`;
  }

  generateListItemDescription(topic) {
    return `This aspect of ${topic} is crucial because it fundamentally changes how we approach the subject. Understanding this will give you a significant advantage.`;
  }

  generateImpactStatement() {
    const impacts = [
      'This alone can save you hours',
      'Game-changing for beginners',
      'Essential for long-term success',
      'Often overlooked but critical',
      'The difference between success and failure'
    ];
    
    return impacts[Math.floor(Math.random() * impacts.length)];
  }

  async generatePros(_strategy) {
    return {
      type: 'pros',
      title: 'The Benefits',
      points: [
        'Easy to get started',
        'Cost-effective solution',
        'Proven results',
        'Scalable approach',
        'Community support'
      ],
      duration: 45
    };
  }

  async generateCons(_strategy) {
    return {
      type: 'cons',
      title: 'Things to Consider',
      points: [
        'Learning curve at the beginning',
        'Requires consistent effort',
        'Results may vary',
        'Some technical knowledge helpful'
      ],
      duration: 30
    };
  }

  async generateComparison(strategy) {
    return {
      type: 'comparison',
      title: 'How It Compares',
      content: `Compared to alternatives, ${strategy.topic} stands out because of its unique approach and proven effectiveness.`,
      comparisonPoints: [
        'More efficient than traditional methods',
        'Better ROI than competitors',
        'Easier to implement',
        'More sustainable long-term'
      ],
      duration: 60
    };
  }

  async generateImplications(strategy) {
    return {
      type: 'implications',
      title: 'What This Means',
      content: [
        `The implications of ${strategy.topic} are far-reaching.`,
        'This will change how we think about the industry.',
        'Early adopters will have a significant advantage.',
        'The potential for growth is enormous.'
      ],
      duration: 45
    };
  }

  generateGenericSection(sectionType, strategy) {
    return {
      type: sectionType,
      title: sectionType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      content: `This section covers important aspects of ${strategy.topic} that you need to know.`,
      duration: 60
    };
  }

  /**
   * The closing used to be the same six lines on every video — "We covered the
   * key points: the fundamentals and why they matter, practical steps to get
   * started..." and then "is a journey, not a destination. Keep learning and
   * improving!" It never came from the model, even when everything before it
   * did, so a video about a fifteenth-century chronicle ended by listing
   * practical steps it had never given, read aloud in the narration.
   *
   * The model now writes the closing lines. The template, used only when no
   * provider is configured, says one sentence and claims nothing it did not do.
   * recap and finalThought keep their names and types: TTS assembly, scene
   * splitting and the formatted script all read them.
   */
  async generateConclusion(strategy, closing = null) {
    const lines = Array.isArray(closing)
      ? closing.map(line => String(line || '').trim()).filter(Boolean)
      : (typeof closing === 'string' && closing.trim() ? [closing.trim()] : []);

    return {
      type: 'conclusion',
      title: 'Conclusion',
      recap: [],
      finalThought: lines.length
        ? lines.join(' ')
        : `That is where the record leaves ${strategy.topic}.`,
      duration: '30 seconds'
    };
  }

  async generateCTA(strategy) {
    return {
      type: 'call_to_action',
      subscribe: String(strategy?.callToAction || this.defaultSubscribeLine(strategy)),
      like: '',
      comment: this.defaultCommentLine(),
      nextVideo: '',
      duration: '15 seconds'
    };
  }

  formatFullScript(script) {
    let fullScript = '';
    
    // Title
    fullScript += `TITLE: ${script.title}\n\n`;
    fullScript += '═'.repeat(50) + '\n\n';
    
    // Hook
    fullScript += `[${script.hook.duration}] HOOK\n`;
    fullScript += `${script.hook.text}\n\n`;
    
    // Introduction
    fullScript += `[${script.introduction.duration}] INTRODUCTION\n`;
    // Empty slots are expected now that the opening no longer greets or invents
    // a credential, so print only the lines that carry something.
    for (const line of [
      script.introduction.greeting,
      script.introduction.topicIntro,
      script.introduction.valueProposition,
      script.introduction.credibility
    ].filter(Boolean)) {
      fullScript += `${line}\n`;
    }
    fullScript += '\n';
    
    // Main Content
    fullScript += 'MAIN CONTENT\n';
    fullScript += '─'.repeat(30) + '\n\n';
    
    for (const section of script.mainContent.sections) {
      fullScript += `[${this.formatDuration(section.duration)}] ${section.title.toUpperCase()}\n`;
      
      if (Array.isArray(section.content)) {
        section.content.forEach(line => {
          fullScript += `${line}\n`;
        });
      } else if (section.steps) {
        section.steps.forEach(step => {
          fullScript += `\n${step.title}\n`;
          fullScript += `${step.description}\n`;
          fullScript += `💡 ${step.tip}\n`;
        });
      } else if (section.items) {
        section.items.forEach(item => {
          fullScript += `\n#${item.number}: ${item.title}\n`;
          fullScript += `${item.description}\n`;
          fullScript += `Impact: ${item.impact}\n`;
        });
      } else if (section.points) {
        section.points.forEach(point => {
          fullScript += `• ${point}\n`;
        });
      } else {
        fullScript += `${section.content}\n`;
      }
      
      if (section.visuals) {
        fullScript += `\n[VISUALS: ${section.visuals.join(', ')}]\n`;
      }
      
      fullScript += '\n';
    }
    
    // Conclusion
    fullScript += `[${script.conclusion.duration}] CONCLUSION\n`;
    script.conclusion.recap.forEach(line => {
      fullScript += `${line}\n`;
    });
    fullScript += `\n${script.conclusion.finalThought}\n\n`;
    
    // Call to Action
    fullScript += `[${script.callToAction.duration}] CALL TO ACTION\n`;
    for (const line of [
      script.callToAction.subscribe,
      script.callToAction.like,
      script.callToAction.comment,
      script.callToAction.nextVideo
    ].filter(Boolean)) {
      fullScript += `${line}\n`;
    }
    fullScript += '\n';
    
    // Metadata
    fullScript += '═'.repeat(50) + '\n';
    fullScript += `ESTIMATED DURATION: ${script.duration}\n`;
    fullScript += `TONE: ${script.tone}\n`;
    fullScript += `PACING: ${script.pacing}\n`;
    fullScript += `KEYWORDS: ${script.keywords.join(', ')}\n`;
    
    return fullScript;
  }

  estimateDuration(mainContent) {
    const totalSeconds = mainContent.sections.reduce((total, section) => {
      return total + (section.duration || 60);
    }, 0);
    
    // Add hook, intro, conclusion, CTA
    const fullDuration = totalSeconds + 5 + 15 + 30 + 15;
    
    return this.formatDuration(fullDuration);
  }

  formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  calculateSectionsDuration(sections) {
    return sections.reduce((total, section) => total + (section.duration || 60), 0);
  }
}

module.exports = { ScriptWriterAgent };
