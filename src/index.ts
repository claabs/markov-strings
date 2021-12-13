/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-await-in-loop */
import { assignIn, isString, slice } from 'lodash';
import { Connection, ConnectionOptions, createConnection, getConnectionOptions, In } from 'typeorm';
import { CorpusEntry } from './entity/CorpusEntry';
import { MarkovFragment } from './entity/MarkovFragment';
import { MarkovInputData } from './entity/MarkovInputData';
import { MarkovOptions } from './entity/MarkovOptions';
import { MarkovRoot } from './entity/MarkovRoot';
import {
  MarkovImportExport as MarkovV3ImportExport,
  MarkovFragment as MarkovV3Fragment,
  Corpus as MarkovV3Corpus,
} from './v3-types';

/**
 * Data to build the Markov instance
 */
export type MarkovConstructorOptions = {
  id?: string;
  stateSize?: number;
};

export type MarkovConstructorProps = {
  id?: string;
  options?: MarkovConstructorOptions;
};

/**
 * While `stateSize` is optional as a constructor parameter,
 * it must exist as a member
 */
export type MarkovDataMembers = {
  stateSize: number;
};

export interface AddDataProps {
  string: string;
  custom?: any;
}

export interface MarkovResult<CustomData = never> {
  string: string;
  score: number;
  refs: MarkovInputData<CustomData>[];
  tries: number;
}

export type MarkovGenerateOptions<CustomData> = {
  maxTries?: number;
  filter?: (result: MarkovResult<CustomData>) => boolean;
};

export type Corpus = { [key: string]: MarkovFragment[] };

export interface ImportFragmentExtract {
  refs: MarkovInputData[];
  fragments: MarkovFragment[];
}

export default class Markov {
  // public data: MarkovInputData
  public db: MarkovRoot;

  public options: MarkovOptions | MarkovDataMembers;

  public connection: Connection;

  public id: string;

  private defaultOptions: MarkovDataMembers = {
    stateSize: 2,
  };

  /**
   * Creates an instance of Markov generator.
   *
   * @param {MarkovConstructorProps} [options={}]
   * @memberof Markov
   */
  constructor(props?: MarkovConstructorProps) {
    // this.data = []

    this.id = props?.id || '1';

    // Save options
    this.options = assignIn(this.defaultOptions, props?.options);
  }

  public async connect(connectionOptions?: ConnectionOptions): Promise<Connection> {
    let baseConnectionOpts: ConnectionOptions;
    if (connectionOptions) {
      baseConnectionOpts = connectionOptions;
    } else {
      baseConnectionOpts = await getConnectionOptions();
    }
    this.connection = await createConnection({
      ...baseConnectionOpts,
      entities: [CorpusEntry, MarkovRoot, MarkovOptions, MarkovInputData, MarkovFragment],
    });

    let db = await MarkovRoot.findOne({
      id: this.id,
    });
    if (!db) {
      const options = MarkovOptions.create(this.options);
      await MarkovOptions.save(options);
      this.options = options;
      db = new MarkovRoot();
      db.id = this.id;
      db.options = options;
      await MarkovRoot.save(db);
    }
    this.db = db;
    this.id = this.db.id;
    return this.connection;
  }

  public async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
    }
  }

  // eslint-disable-next-line class-methods-use-this
  private async sampleFragment(
    condition: MarkovRoot | CorpusEntry
  ): Promise<MarkovFragment | undefined> {
    let queryCondition;
    if (condition instanceof MarkovRoot) {
      queryCondition = { startWordMarkov: condition };
    } else {
      queryCondition = { corpusEntry: condition };
    }
    const fragment = await MarkovFragment.createQueryBuilder()
      .where(queryCondition)
      .orderBy('RANDOM()')
      .limit(1)
      .getOne();
    return fragment;
  }

  private extractImportFragments(
    importFragments: MarkovFragment[],
    foreignKey: 'corpusEntry',
    corpusEntry: CorpusEntry
  ): ImportFragmentExtract;

  private extractImportFragments(
    importFragments: MarkovFragment[],
    foreignKey: 'startWordMarkov' | 'endWordMarkov'
  ): ImportFragmentExtract;

  private extractImportFragments(
    importFragments: MarkovFragment[],
    foreignKey: 'startWordMarkov' | 'endWordMarkov' | 'corpusEntry',
    corpusEntry?: CorpusEntry
  ): ImportFragmentExtract {
    const allRefs: MarkovInputData[] = [];
    const fragments = importFragments.map((importFragment) => {
      const fragment = MarkovFragment.create(importFragment);
      if (foreignKey === 'corpusEntry') {
        fragment[foreignKey] = corpusEntry;
      } else {
        fragment[foreignKey] = this.db;
      }
      const refs = importFragment.refs.map((ref) => {
        const markovInputData = MarkovInputData.create(ref);
        markovInputData.fragment = fragment;
        return markovInputData;
      });
      // Push refs to array so we can save them all at once later
      allRefs.push(...refs);
      return fragment;
    });
    return {
      refs: allRefs,
      fragments,
    };
  }

  private async saveImportFragments(
    importFragments: MarkovFragment[],
    foreignKey: 'startWordMarkov' | 'endWordMarkov'
  ): Promise<MarkovFragment[]> {
    const { refs, fragments } = this.extractImportFragments(importFragments, foreignKey);

    await MarkovFragment.save(fragments);
    await MarkovInputData.save(refs);

    return fragments;
  }

  private async saveImportCorpus(importCorpus: CorpusEntry[]): Promise<CorpusEntry[]> {
    const allFragments: MarkovFragment[] = [];
    const allRefs: MarkovInputData[] = [];
    const corpusEntries = importCorpus.map((importCorpusEntry) => {
      const corpusEntry = CorpusEntry.create(importCorpusEntry);
      const { fragments, refs } = this.extractImportFragments(
        importCorpusEntry.fragments,
        'corpusEntry',
        corpusEntry
      );
      allFragments.push(...fragments);
      allRefs.push(...refs);
      corpusEntry.markov = this.db;
      corpusEntry.fragments = fragments;
      return corpusEntry;
    });

    await CorpusEntry.save(corpusEntries);
    await MarkovFragment.save(allFragments);
    await MarkovInputData.save(allRefs);
    return corpusEntries;
  }

  private extractImportV3Fragments(
    importFragments: MarkovV3Fragment[],
    foreignKey: 'corpusEntry',
    corpusEntry: CorpusEntry
  ): ImportFragmentExtract;

  private extractImportV3Fragments(
    importFragments: MarkovV3Fragment[],
    foreignKey: 'startWordMarkov' | 'endWordMarkov'
  ): ImportFragmentExtract;

  private extractImportV3Fragments(
    importFragments: MarkovV3Fragment[],
    foreignKey: 'startWordMarkov' | 'endWordMarkov' | 'corpusEntry',
    corpusEntry?: CorpusEntry
  ): ImportFragmentExtract {
    const allRefs: MarkovInputData[] = [];
    const fragments = importFragments.map((importFragment) => {
      const fragment = new MarkovFragment();
      if (foreignKey === 'corpusEntry') {
        fragment[foreignKey] = corpusEntry;
      } else {
        fragment[foreignKey] = this.db;
      }
      fragment.words = importFragment.words;
      // Push refs to array so we can save them all at once later
      const refs = importFragment.refs.map((ref) => {
        const { string } = ref; // Save string as the following delete will delete ref.string as well
        const customData: Record<string, any> = ref;
        delete customData.string; // Only keep custom data
        const markovInputData = new MarkovInputData();
        markovInputData.fragment = fragment;
        markovInputData.string = string;
        if (Object.keys(customData).length) markovInputData.custom = customData;
        return markovInputData;
      });
      allRefs.push(...refs);

      return fragment;
    });
    return {
      refs: allRefs,
      fragments,
    };
  }

  private async saveImportV3Fragments(
    importFragments: MarkovV3Fragment[],
    foreignKey: 'startWordMarkov' | 'endWordMarkov'
  ): Promise<MarkovFragment[]> {
    const { refs, fragments } = this.extractImportV3Fragments(importFragments, foreignKey);

    await MarkovFragment.save(fragments);
    await MarkovInputData.save(refs);

    return fragments;
  }

  private async saveImportV3Corpus(importCorpus: MarkovV3Corpus): Promise<CorpusEntry[]> {
    const allFragments: MarkovFragment[] = [];
    const allRefs: MarkovInputData[] = [];
    const corpusEntries = Object.entries(importCorpus).map(([key, importFragments]) => {
      const corpusEntry = new CorpusEntry();
      const { fragments, refs } = this.extractImportV3Fragments(
        importFragments,
        'corpusEntry',
        corpusEntry
      );
      allFragments.push(...fragments);
      allRefs.push(...refs);
      corpusEntry.markov = this.db;
      corpusEntry.block = key;
      corpusEntry.fragments = fragments;
      return corpusEntry;
    });

    await CorpusEntry.save(corpusEntries);
    await MarkovFragment.save(allFragments);
    await MarkovInputData.save(allRefs);
    return corpusEntries;
  }

  /**
   * Imports a corpus.
   * Overwrites only if the imported V4 schema uses the same ID
   * Always overwrites with v3 schema
   * @param data
   */
  public async import(data: MarkovRoot | MarkovV3ImportExport): Promise<void> {
    if ('id' in data) {
      const db = await MarkovRoot.preload(data);
      if (db) {
        this.db = db;
      } else {
        const options = MarkovOptions.create(data.options);
        await MarkovOptions.save(options);
        this.db = new MarkovRoot();
        this.db.id = this.id;
        this.db.options = options;

        const startWords = await this.saveImportFragments(data.startWords, 'startWordMarkov');
        const endWords = await this.saveImportFragments(data.endWords, 'endWordMarkov');
        const corpus = await this.saveImportCorpus(data.corpus);
        this.db.id = this.id;
        this.db.options = options;
        this.db.startWords = startWords;
        this.db.endWords = endWords;
        this.db.corpus = corpus;
        await MarkovRoot.save(this.db);
      }
    } else {
      // Legacy import
      const options = MarkovOptions.create(data.options);
      await MarkovOptions.save(options);
      this.db = new MarkovRoot();
      this.db.id = this.id;
      this.db.options = options;

      const startWords = await this.saveImportV3Fragments(data.startWords, 'startWordMarkov');
      const endWords = await this.saveImportV3Fragments(data.endWords, 'endWordMarkov');
      const corpus = await this.saveImportV3Corpus(data.corpus);

      this.db.id = this.id;
      this.db.options = options;
      this.db.startWords = startWords;
      this.db.endWords = endWords;
      this.db.corpus = corpus;
      await MarkovRoot.save(this.db);
    }
    this.id = this.db.id;
    this.options = this.db.options;
  }

  /**
   * Exports structed data used to generate sentence.
   */
  public async export(): Promise<MarkovRoot> {
    const db = await MarkovRoot.findOneOrFail({
      where: { id: this.id },
      relations: [
        'corpus',
        'corpus.fragments',
        'corpus.fragments.refs',
        'startWords',
        'startWords.refs',
        'endWords',
        'endWords.refs',
        'options',
      ],
      loadEagerRelations: true,
    });
    return db;
  }

  public async addData(rawData: AddDataProps[] | string[]) {
    // Format data if necessary
    let input: AddDataProps[] = [];
    if (isString(rawData[0])) {
      input = (rawData as string[]).map((s) => ({ string: s }));
    } else if (Object.hasOwnProperty.call(rawData[0], 'string')) {
      input = rawData as AddDataProps[];
    } else {
      throw new Error('Objects in your corpus must have a "string" property');
    }

    await this.buildCorpus(input);

    // this.data = this.data.concat(input)
  }

  /**
   * Builds the corpus. You must call this before generating sentences.
   *
   * @memberof Markov
   */
  private async buildCorpus(data: AddDataProps[]): Promise<void> {
    const { options } = this.db;

    // Loop through all sentences
    // eslint-disable-next-line no-restricted-syntax
    for (const item of data) {
      const line = item.string;
      const words = line.split(' ');
      const { stateSize } = options; // Default value of 2 is set in the constructor

      // #region Start words
      // "Start words" is the list of words that can start a generated chain.

      const start = slice(words, 0, stateSize).join(' ');
      const oldStartObj = await MarkovFragment.findOne({ startWordMarkov: this.db, words: start });

      // If we already have identical startWords
      if (oldStartObj) {
        let inputData = await MarkovInputData.findOne({ fragment: oldStartObj });
        // If the current item is not present in the references, add it
        if (!inputData) {
          inputData = new MarkovInputData();
          inputData.fragment = oldStartObj;
          inputData.string = item.string;
          inputData.custom = item.custom;
          await MarkovInputData.save(inputData);
        }
      } else {
        // Add the startWords (and reference) to the list
        const fragment = new MarkovFragment();
        fragment.words = start;
        fragment.startWordMarkov = this.db;
        await MarkovFragment.save(fragment);
        const ref = new MarkovInputData();
        ref.fragment = fragment;
        ref.string = item.string;
        ref.custom = item.custom;
        await MarkovInputData.save(ref);
      }

      // #endregion Start words

      // #region End words
      // "End words" is the list of words that can end a generated chain.

      const end = slice(words, words.length - stateSize, words.length).join(' ');
      const oldEndObj = await MarkovFragment.findOne({ endWordMarkov: this.db, words: end });
      if (oldEndObj) {
        let inputData = await MarkovInputData.findOne({ fragment: oldEndObj });
        // If the current item is not present in the references, add it
        if (!inputData) {
          inputData = new MarkovInputData();
          inputData.fragment = oldEndObj;
          inputData.string = item.string;
          inputData.custom = item.custom;
          await MarkovInputData.save(inputData);
        }
      } else {
        const fragment = new MarkovFragment();
        fragment.words = end;
        fragment.endWordMarkov = this.db;
        await MarkovFragment.save(fragment);
        const ref = new MarkovInputData();
        ref.fragment = fragment;
        ref.string = item.string;
        ref.custom = item.custom;
        await MarkovInputData.save(ref);
      }

      // #endregion End words

      // #region Corpus generation

      // We loop through all words in the sentence to build "blocks" of `stateSize`
      // e.g. for a stateSize of 2, "lorem ipsum dolor sit amet" will have the following blocks:
      //    "lorem ipsum", "ipsum dolor", "dolor sit", and "sit amet"
      for (let i = 0; i < words.length - 1; i += 1) {
        const curr = slice(words, i, i + stateSize).join(' ');
        const next = slice(words, i + stateSize, i + stateSize * 2).join(' ');
        if (!next || next.split(' ').length !== options.stateSize) {
          // eslint-disable-next-line no-continue
          continue;
        }

        // Check if the corpus already has a corresponding "curr" block
        const block = await CorpusEntry.findOne({ markov: this.db, block: curr });
        if (block) {
          const oldObj = await MarkovFragment.findOne({ corpusEntry: block, words: next });
          if (oldObj) {
            // If the corpus already has the chain "curr -> next",
            // just add the current reference for this block
            const ref = new MarkovInputData();
            ref.fragment = oldObj;
            ref.string = item.string;
            ref.custom = item.custom;
            await MarkovInputData.save(ref);
          } else {
            // Add the new "next" block in the list of possible paths for "curr"
            const fragment = new MarkovFragment();
            fragment.words = next;
            fragment.corpusEntry = block;
            await MarkovFragment.save(fragment);
            const ref = new MarkovInputData();
            ref.fragment = fragment;
            ref.string = item.string;
            ref.custom = item.custom;
            await MarkovInputData.save(ref);
          }
        } else {
          // Add the "curr" block and link it with the "next" one
          const entry = new CorpusEntry();
          entry.block = curr;
          entry.markov = this.db;
          await CorpusEntry.save(entry);
          const fragment = new MarkovFragment();
          fragment.words = next;
          fragment.corpusEntry = entry;
          await MarkovFragment.save(fragment);
          const ref = new MarkovInputData();
          ref.fragment = fragment;
          ref.string = item.string;
          ref.custom = item.custom;
          await MarkovInputData.save(ref);
        }
      }

      // #endregion Corpus generation
    }
  }

  /**
   * Generates a result, that contains a string and its references
   *
   * @param {MarkovGenerateOptions} [options={}]
   * @returns {MarkovResult}
   * @memberof Markov
   */
  public async generate<CustomData = any>(
    options: MarkovGenerateOptions<CustomData> = {}
  ): Promise<MarkovResult<CustomData>> {
    // const corpusSize = await CorpusEntry.count({markov: this.db});
    const corpusSize = await CorpusEntry.count({ markov: this.db });
    if (corpusSize <= 0) {
      throw new Error(
        'Corpus is empty. There is either no data, or the data is not sufficient to create markov chains.'
      );
    }

    // const corpus = cloneDeep(this.corpus)
    const maxTries = options.maxTries ? options.maxTries : 10;

    let tries: number;

    // We loop through fragments to create a complete sentence
    for (tries = 1; tries <= maxTries; tries += 1) {
      let ended = false;

      // Create an array of MarkovCorpusItems
      // The first item is a random startWords element
      const arr = [(await this.sampleFragment(this.db))!];

      let score = 0;

      // loop to build a complete sentence
      for (let innerTries = 0; innerTries < maxTries; innerTries += 1) {
        const block = arr[arr.length - 1]; // last value in array
        const entry = await CorpusEntry.findOne({ where: { block: block.words } });
        if (!entry) break;

        const state = await this.sampleFragment(entry); // Find a following item in the corpus

        // If a state cannot be found, the sentence can't be completed
        if (!state) break;

        // add new state to list
        arr.push(state);

        // increment score
        score += state.words.length - 1; // increment score

        // is sentence finished?
        const endWords = await MarkovFragment.findOne({
          endWordMarkov: this.db,
          words: state.words,
        });
        if (endWords) {
          ended = true;
          break;
        }
      }

      const sentence = arr
        .map((o) => o.words)
        .join(' ')
        .trim();

      const refs = await MarkovInputData.find<MarkovInputData<CustomData>>({
        fragment: { id: In(arr.map((f) => f.id)) },
      });

      const result = {
        string: sentence,
        score,
        refs,
        tries,
      };

      // sentence is not ended or incorrect
      if (!ended || (typeof options.filter === 'function' && !options.filter(result))) {
        // eslint-disable-next-line no-continue
        continue;
      }

      return result;
    }
    throw new Error(
      `Failed to build a sentence after ${
        tries - 1
      } tries. Possible solutions: try a less restrictive filter(), give more raw data to the corpus builder, or increase the number of maximum tries.`
    );
  }
}
