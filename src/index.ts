/* eslint-disable no-await-in-loop */
import { Connection, ConnectionOptions, EntitySchema, getConnectionOptions, In } from 'typeorm';
import { MarkovCorpusEntry } from './entity/MarkovCorpusEntry';
import { MarkovFragment } from './entity/MarkovFragment';
import { MarkovInputData } from './entity/MarkovInputData';
import { MarkovOptions } from './entity/MarkovOptions';
import { MarkovRoot } from './entity/MarkovRoot';
import { Importer } from './importer';
import { MarkovImportExport as MarkovV3ImportExport } from './v3-types';

const ALL_ENTITIES = [
  MarkovCorpusEntry,
  MarkovRoot,
  MarkovOptions,
  MarkovInputData,
  MarkovFragment,
];

/**
 * Data to build the Markov instance
 */
export type MarkovConstructorOptions = {
  /**
   * Used to set the options database ID manually
   */
  id?: string;

  /**
   * The stateSize is the number of words for each "link" of the generated sentence.
   * 1 will output gibberish sentences without much sense.
   * 2 is a sensible default for most cases.
   * 3 and more can create good sentences if you have a corpus that allows it.
   */
  stateSize?: number;
};

export type MarkovConstructorProps = {
  /**
   * Used to set a root database ID manually
   */
  id?: string;

  /**
   * Global Markov corpus generation options
   */
  options?: MarkovConstructorOptions;
};

/**
 * While `stateSize` is optional as a constructor parameter,
 * it must exist as a member
 */
export interface MarkovDataMembers {
  stateSize: number;
}

export interface AddDataProps {
  /**
   * A string that the corpus is built from
   */
  string: string;

  /**
   * A JSON-like object that will be returned alongside the refs in the result
   */
  custom?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface MarkovResult<CustomData = never> {
  /**
   * The resulting sentence
   */
  string: string;

  /**
   * A relative "score" based on the number of possible permutations.
   * Higher is "better", but the actual value depends on your corpus.
   */
  score: number;

  /**
   * The array of references used to build the sentence.
   */
  refs: MarkovInputData<CustomData>[];

  /**
   * The number of tries it took to output this result
   */
  tries: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MarkovGenerateOptions<CustomData = any> = {
  /**
   * The max number of tentatives before giving up (default is 10)
   */
  maxTries?: number;

  /**
   * A callback to filter results (see example in the Readme)
   */
  filter?: (result: MarkovResult<CustomData>) => boolean;
};

export type Corpus = Record<string, MarkovFragment[]>;

export default class Markov {
  public db: MarkovRoot;

  public options: MarkovOptions | MarkovDataMembers;

  public id: string;

  private defaultOptions: MarkovDataMembers = {
    stateSize: 2,
  };

  private constructorProps?: MarkovConstructorProps;

  /**
   * If you're connecting the Markov DB with your parent project's DB, you'll need to extend it to add the Markov entities to the connection.
   * @param connectionOptions Your TypeORM connection options. If not provided, it will load the ormconfig from a file.
   * @returns ConnectionOptions that should be passed into a createConnection() call.
   */
  public static async extendConnectionOptions(
    connectionOptions?: ConnectionOptions
  ): Promise<ConnectionOptions> {
    let baseConnectionOpts: ConnectionOptions;
    if (connectionOptions) {
      baseConnectionOpts = connectionOptions;
    } else {
      baseConnectionOpts = await getConnectionOptions();
    }

    // eslint-disable-next-line @typescript-eslint/ban-types, @typescript-eslint/no-explicit-any
    const appendedEntities: (Function | string | EntitySchema<any>)[] = ALL_ENTITIES;
    if (baseConnectionOpts.entities) appendedEntities.push(...baseConnectionOpts.entities);
    return {
      ...baseConnectionOpts,
      entities: appendedEntities,
    };
  }

  /**
   * Creates an instance of Markov generator.
   */
  constructor(props?: MarkovConstructorProps) {
    this.constructorProps = props;
    this.construct();
  }

  private construct() {
    this.id = this.constructorProps?.id || '1';

    // Save options
    this.options = Object.assign(this.defaultOptions, this.constructorProps?.options);
  }

  /**
   * If you have a non-default connection (you probably don't), pass it in here.
   * Otherwise, setup() is called implicitly on any async function.
   * @param connection A non-default connection to be used by Markov's entities
   */
  public async setup(connection?: Connection): Promise<void> {
    if (connection) ALL_ENTITIES.forEach((e) => e.useConnection(connection));

    let db = await MarkovRoot.findOne({
      id: this.id,
    });
    let options: MarkovOptions;
    if (!db) {
      options = MarkovOptions.create(this.options);
      await MarkovOptions.save(options);
      this.options = options;
      db = new MarkovRoot();
      db.id = this.id;
      db.options = options;
      await MarkovRoot.save(db);
    } else {
      options = await MarkovOptions.findOneOrFail(db.options);
    }
    this.db = db;
    this.id = this.db.id;
    this.options = options;
  }

  private async ensureSetup(): Promise<void> {
    if (!this.db) await this.setup();
  }

  /**
   * Gets a random fragment for a startWord or corpusEntry from the database.
   */
  private async sampleFragment(condition?: MarkovCorpusEntry): Promise<MarkovFragment | undefined> {
    let queryCondition;
    if (!condition) {
      queryCondition = { startWordMarkov: this.db };
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

  /**
   * Imports a corpus. This overwrites existing data.
   * Supports imports from markov-strings v3, as well as exports from this version.
   */
  public async import(data: MarkovRoot | MarkovV3ImportExport): Promise<void> {
    await this.ensureSetup();
    if ('id' in data) {
      this.db = new MarkovRoot();
      this.db.id = this.id;
      const options = MarkovOptions.create(data.options);
      this.db.options = options;
      await MarkovOptions.save(options);

      const importer = new Importer(this.db);
      const startWords = await importer.saveImportFragments(data.startWords, 'startWordMarkov');
      const endWords = await importer.saveImportFragments(data.endWords, 'endWordMarkov');
      const corpus = await importer.saveImportCorpus(data.corpus);
      this.db.id = this.id;
      this.db.options = options;
      this.db.startWords = startWords;
      this.db.endWords = endWords;
      this.db.corpus = corpus;
      await MarkovRoot.save(this.db);
    } else {
      // Legacy import
      const options = MarkovOptions.create(data.options);
      await MarkovOptions.save(options);
      this.db = new MarkovRoot();
      this.db.id = this.id;
      this.db.options = options;

      const importer = new Importer(this.db);
      const startWords = await importer.saveImportV3Fragments(data.startWords, 'startWordMarkov');
      const endWords = await importer.saveImportV3Fragments(data.endWords, 'endWordMarkov');
      const corpus = await importer.saveImportV3Corpus(data.corpus);

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
   * Exports all the data in the database associated with this Markov instance as a JSON object.
   */
  public async export(): Promise<MarkovRoot> {
    await this.ensureSetup();
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

  /**
   * To function correctly, the Markov generator needs its internal data to be correctly structured. This allows you add raw data, that is automatically formatted to fit the internal structure.
   * You can call this as often as you need, with new data each time. Multiple calls with the same data is not recommended, because it will skew the random generation of results.
   * It's possible to store custom JSON-like data of your choice next to the string by passing in objects of `{ string: 'foo', custom: 'attachment' }`. This data will be returned in the `refs` of the result.
   */
  public async addData(rawData: AddDataProps[] | string[]): Promise<void> {
    await this.ensureSetup();
    if (!rawData.length) return;
    // Format data if necessary
    let input: AddDataProps[] = [];
    if (typeof rawData[0] === 'string') {
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
   */
  private async buildCorpus(data: AddDataProps[]): Promise<void> {
    await this.ensureSetup();
    const { options } = this;

    // Loop through all sentences
    // eslint-disable-next-line no-restricted-syntax
    for (const item of data) {
      // Arrays to store future DB writes so we can write them all in one transaction
      const entriesToSave: MarkovCorpusEntry[] = [];
      const fragmentsToSave: MarkovFragment[] = [];
      const inputDataToSave: MarkovInputData[] = [];

      const line = item.string;
      const words = line.split(' ');
      const { stateSize } = options; // Default value of 2 is set in the constructor

      // #region Start words
      // "Start words" is the list of words that can start a generated chain.

      const start = words.slice(0, stateSize).join(' ');
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
          inputDataToSave.push(inputData);
        }
      } else {
        // Add the startWords (and reference) to the list
        const fragment = new MarkovFragment();
        fragment.words = start;
        fragment.startWordMarkov = this.db;
        fragmentsToSave.push(fragment);
        const ref = new MarkovInputData();
        ref.fragment = fragment;
        ref.string = item.string;
        ref.custom = item.custom;
        inputDataToSave.push(ref);
      }

      // #endregion Start words

      // #region End words
      // "End words" is the list of words that can end a generated chain.

      const end = words.slice(words.length - stateSize, words.length).join(' ');
      const oldEndObj = await MarkovFragment.findOne({ endWordMarkov: this.db, words: end });
      if (oldEndObj) {
        let inputData = await MarkovInputData.findOne({ fragment: oldEndObj });
        // If the current item is not present in the references, add it
        if (!inputData) {
          inputData = new MarkovInputData();
          inputData.fragment = oldEndObj;
          inputData.string = item.string;
          inputData.custom = item.custom;
          inputDataToSave.push(inputData);
        }
      } else {
        const fragment = new MarkovFragment();
        fragment.words = end;
        fragment.endWordMarkov = this.db;
        fragmentsToSave.push(fragment);
        const ref = new MarkovInputData();
        ref.fragment = fragment;
        ref.string = item.string;
        ref.custom = item.custom;
        inputDataToSave.push(ref);
      }

      // #endregion End words

      // #region Corpus generation

      // We loop through all words in the sentence to build "blocks" of `stateSize`
      // e.g. for a stateSize of 2, "lorem ipsum dolor sit amet" will have the following blocks:
      //    "lorem ipsum", "ipsum dolor", "dolor sit", and "sit amet"
      for (let i = 0; i < words.length - 1; i += 1) {
        const curr = words.slice(i, i + stateSize).join(' ');
        const next = words.slice(i + stateSize, i + stateSize * 2).join(' ');
        if (!next || next.split(' ').length !== options.stateSize) {
          // eslint-disable-next-line no-continue
          continue;
        }

        // Check if the corpus already has a corresponding "curr" block
        const block = await MarkovCorpusEntry.findOne({ markov: this.db, block: curr });
        if (block) {
          const oldObj = await MarkovFragment.findOne({ corpusEntry: block, words: next });
          if (oldObj) {
            // If the corpus already has the chain "curr -> next",
            // just add the current reference for this block
            const ref = new MarkovInputData();
            ref.fragment = oldObj;
            ref.string = item.string;
            ref.custom = item.custom;
            inputDataToSave.push(ref);
          } else {
            // Add the new "next" block in the list of possible paths for "curr"
            const fragment = new MarkovFragment();
            fragment.words = next;
            fragment.corpusEntry = block;
            fragmentsToSave.push(fragment);
            const ref = new MarkovInputData();
            ref.fragment = fragment;
            ref.string = item.string;
            ref.custom = item.custom;
            inputDataToSave.push(ref);
          }
        } else {
          // Add the "curr" block and link it with the "next" one
          const entry = new MarkovCorpusEntry();
          entry.block = curr;
          entry.markov = this.db;
          entriesToSave.push(entry);
          const fragment = new MarkovFragment();
          fragment.words = next;
          fragment.corpusEntry = entry;
          fragmentsToSave.push(fragment);
          const ref = new MarkovInputData();
          ref.fragment = fragment;
          ref.string = item.string;
          ref.custom = item.custom;
          inputDataToSave.push(ref);
        }
      }

      // Save the fragments and input data as they will be needed in the DB for corpus generation
      await MarkovCorpusEntry.save(entriesToSave);
      await MarkovFragment.save(fragmentsToSave);
      await MarkovInputData.save(inputDataToSave);
    }
  }

  /**
   * Remove a string and all its references from the database
   * @param rawData A list of full strings
   */
  public async removeData(rawData: string[]): Promise<void> {
    await this.ensureSetup();
    const inputData = await MarkovInputData.find({
      relations: ['fragment', 'fragment.corpusEntry'],
      where: [
        {
          string: rawData,
          fragment: { startWordMarkov: this.db },
        },
        {
          string: rawData,
          fragment: { endWordMarkov: this.db },
        },
        {
          string: rawData,
          fragment: { corpusEntry: { markov: this.db } },
        },
      ],
    });
    const uniqueFragments = [
      ...new Map(inputData.map((d) => [d.fragment.id, d.fragment])).values(),
    ];
    const uniqueCorpusEntries = [
      ...new Map(uniqueFragments.map((f) => [f.corpusEntry?.id, f.corpusEntry])).values(),
    ].filter((c): c is MarkovCorpusEntry => c !== null);

    await MarkovInputData.remove(inputData);
    await MarkovFragment.remove(uniqueFragments);
    await MarkovCorpusEntry.remove(uniqueCorpusEntries);
  }

  /**
   * Delete this instance's entire database and reset the ID
   */
  public async delete(): Promise<void> {
    await this.ensureSetup();

    if (this.options instanceof MarkovOptions) await MarkovOptions.remove(this.options);
    await MarkovRoot.remove(this.db);
    this.construct();
  }

  /**
   * Generates a result, that contains a string and its references.
   */
  public async generate<CustomData = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
    options?: MarkovGenerateOptions<CustomData>
  ): Promise<MarkovResult<CustomData>> {
    await this.ensureSetup();
    const corpusSize = await MarkovCorpusEntry.count({ markov: this.db });
    if (corpusSize <= 0) {
      throw new Error(
        'Corpus is empty. There is either no data, or the data is not sufficient to create markov chains.'
      );
    }

    const maxTries = options?.maxTries ? options.maxTries : 10;

    let tries: number;

    // We loop through fragments to create a complete sentence
    for (tries = 1; tries <= maxTries; tries += 1) {
      let ended = false;

      // Create an array of MarkovCorpusItems
      // The first item is a random startWords element
      const firstSample = await this.sampleFragment();
      if (!firstSample)
        throw new Error(
          'Could not get a random fragment. There is either no data, or the data is not sufficient to create markov chains.'
        );
      const arr = [firstSample];

      let score = 0;

      // loop to build a complete sentence
      for (let innerTries = 0; innerTries < maxTries; innerTries += 1) {
        const block = arr[arr.length - 1]; // last value in array
        const entry = await MarkovCorpusEntry.findOne({ where: { block: block.words } });
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
      if (!ended || (typeof options?.filter === 'function' && !options.filter(result))) {
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
