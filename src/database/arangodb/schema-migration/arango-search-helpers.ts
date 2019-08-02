import { Database } from 'arangojs';
import { ArangoSearchView, ArangoSearchViewProperties, ArangoSearchViewPropertiesOptions } from 'arangojs/lib/cjs/view';
import * as _ from 'lodash';
import { QuickSearchLanguage } from '../../../model/config';
import { Field, Model, RootEntityType } from '../../../model/implementation';
import { getCollectionNameForRootEntity } from '../arango-basics';
import { CreateArangoSearchViewMigration, DropArangoSearchViewMigration, UpdateArangoSearchViewMigration } from './migrations';

export const IDENTITY_ANALYZER = 'identity';
export const QUICK_SEARCH_VIEW_PREFIX = 'qsView_';

export interface ArangoSearchDefinition {
    readonly viewName: string;
    readonly collectionName: string;
    readonly fields: ReadonlyArray<Field>
}

interface ArangoSearchViewCollectionLink {
    analyzers?: string[];
    fields?: {
        [key: string]: ArangoSearchViewCollectionLink | undefined;
    };
    includeAllFields?: boolean;
    trackListPositions?: boolean;
    storeValues?: 'none' | 'id';
}

export interface ArangoSearchConfiguration {
    recursionDepth?: number
    commitIntervalMsec?: number
}

export function getRequiredViewsFromModel(model: Model): ReadonlyArray<ArangoSearchDefinition> {
    return model.rootEntityTypes
        .filter(value => value.arangoSearchConfig.isIndexed)
        .map(rootEntity => getViewForRootEntity(rootEntity));
}

export function getQuickSearchViewNameForRootEntity(rootEntity: RootEntityType) {
    return QUICK_SEARCH_VIEW_PREFIX + getCollectionNameForRootEntity(rootEntity);
}

function getViewForRootEntity(rootEntity: RootEntityType): ArangoSearchDefinition {
    return {
        fields: rootEntity.fields.filter(value => value.isQuickSearchIndexed || value.isQuickSearchFulltextIndexed),
        viewName: getQuickSearchViewNameForRootEntity(rootEntity),
        collectionName: getCollectionNameForRootEntity(rootEntity)
    };

}


export async function calculateRequiredArangoSearchViewCreateOperations(existingViews: ArangoSearchView[], requiredViews: ReadonlyArray<ArangoSearchDefinition>, db: Database, configuration?: ArangoSearchConfiguration): Promise<ReadonlyArray<CreateArangoSearchViewMigration>> {
    let viewsToCreate = requiredViews.filter(value => !existingViews.some(value1 => value1.name === value.viewName));

    async function mapToMigration(value: ArangoSearchDefinition): Promise<CreateArangoSearchViewMigration> {
        const colExists = await db.collection(value.collectionName).exists();
        const count: number = (colExists) ? (await db.collection(value.collectionName).count()).count : 0;
        return new CreateArangoSearchViewMigration({
            collectionSize: count,
            collectionName: value.collectionName,
            viewName: value.viewName,
            properties: getPropertiesFromDefinition(value, configuration)
        });
    }

    return await Promise.all(viewsToCreate.map(mapToMigration));
}

export function calculateRequiredArangoSearchViewDropOperations(views: ArangoSearchView[], definitions: ReadonlyArray<ArangoSearchDefinition>): ReadonlyArray<DropArangoSearchViewMigration> {
    const viewsToDrop = views
        .filter(value => !definitions.some(value1 => value1.viewName === value.name) && value.name.startsWith(QUICK_SEARCH_VIEW_PREFIX));
    return viewsToDrop.map(value => new DropArangoSearchViewMigration({ viewName: value.name }));
}


export function getAnalyzerFromQuickSearchLanguage(quickSearchLanguage?: QuickSearchLanguage): string {
    return quickSearchLanguage ? 'text_' + quickSearchLanguage.toLowerCase() : 'identity';
}


function getPropertiesFromDefinition(definition: ArangoSearchDefinition, configuration?: ArangoSearchConfiguration): ArangoSearchViewPropertiesOptions {
    const recursionDepth = configuration && configuration.recursionDepth ? configuration.recursionDepth : 1;
    const properties: any /*ArangoSearchViewPropertiesOptions*/ = {
        links: {},
        commitIntervalMsec: configuration && configuration.commitIntervalMsec ? configuration.commitIntervalMsec : 1000
    };

    const link: ArangoSearchViewCollectionLink = {
        analyzers: [IDENTITY_ANALYZER],
        includeAllFields: false,
        storeValues: 'id',
        trackListPositions: false,
        fields: {}
    };

    function fieldDefinitionFor(field: Field, recursionDepth: number, path: ReadonlyArray<Field> = []): ArangoSearchViewCollectionLink {
        if (field.type.isObjectType) {
            const fields: { [key: string]: ArangoSearchViewCollectionLink | undefined; } = {};
            field.type.fields
                .filter(field => (field.isQuickSearchIndexed || field.isQuickSearchFulltextIndexed)
                    && !path.some(value => value.name === field.name && field.declaringType.name === value.declaringType.name))
                .forEach(value => fields[value.name] = fieldDefinitionFor(value, recursionDepth, path.concat(field)));
            return {
                fields
            };
        } else {
            const analyzers: string[] = [];
            if (field.isQuickSearchFulltextIndexed && field.language) {
                analyzers.push(getAnalyzerFromQuickSearchLanguage(field.language));
            }
            if (field.isQuickSearchIndexed) {
                analyzers.push(IDENTITY_ANALYZER);
            }
            if (_.isEqual(analyzers, [IDENTITY_ANALYZER])) {
                return {};
            } else {
                return {
                    analyzers
                };
            }
        }
    }

    for (const field of definition.fields) {
        link.fields![field.name] = fieldDefinitionFor(field, recursionDepth);
    }

    properties.links![definition.collectionName] = link;

    return properties;
}

function isEqualProperties(defProperties: ArangoSearchViewPropertiesOptions, properties: ArangoSearchViewProperties): boolean {
    return _.isEqual(defProperties.links, properties.links);

}

export async function calculateRequiredArangoSearchViewUpdateOperations(views: ArangoSearchView[], definitions: ReadonlyArray<ArangoSearchDefinition>, db: Database, configuration?: ArangoSearchConfiguration): Promise<ReadonlyArray<UpdateArangoSearchViewMigration>> {
    const viewsWithUpdateRequired: UpdateArangoSearchViewMigration[] = [];
    for (const view of views) {
        const definition = definitions.find(value => value.viewName === view.name);
        if (!definition) {
            continue;
        }
        const viewProperties = await view.properties();

        const definitionProperties = getPropertiesFromDefinition(definition, configuration);
        if (!isEqualProperties(definitionProperties, viewProperties)) {
            const colExists = await db.collection(definition.collectionName).exists();
            const count: number = (colExists) ? (await db.collection(definition.collectionName).count()).count : 0;
            viewsWithUpdateRequired.push(new UpdateArangoSearchViewMigration({
                viewName: definition.viewName,
                collectionName: definition.collectionName,
                collectionSize: count,
                properties: definitionProperties
            }));
        }


    }

    return viewsWithUpdateRequired;
}