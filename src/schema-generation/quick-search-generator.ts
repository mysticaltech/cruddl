import { GraphQLString } from 'graphql';
import { Field, RootEntityType } from '../model/implementation';
import { BinaryOperationQueryNode, BinaryOperator, BinaryOperatorWithLanguage, ConditionalQueryNode, ConstBoolQueryNode, CountQueryNode, FieldPathQueryNode, LiteralQueryNode, OperatorWithLanguageQueryNode, PreExecQueryParms, QueryNode, RuntimeErrorQueryNode, TransformListQueryNode, VariableQueryNode, WithPreExecutionQueryNode } from '../query-tree';
import { QuickSearchQueryNode } from '../query-tree/quick-search';
import { simplifyBooleans } from '../query-tree/utils';
import { FILTER_ARG, ORDER_BY_ARG, QUICK_SEARCH_EXPRESSION_ARG, QUICK_SEARCH_FILTER_ARG } from '../schema/constants';
import { getMetaFieldName, getQuickSearchEntitiesFieldName } from '../schema/names';
import { decapitalize } from '../utils/utils';
import { ListAugmentation } from './list-augmentation';
import { OutputTypeGenerator } from './output-type-generator';
import { QueryNodeField, QueryNodeListType, QueryNodeNonNullType, QueryNodeObjectType, QueryNodeResolveInfo } from './query-node-object-type';
import { or } from './quick-search-filter-input-types/constants';
import { QuickSearchFilterObjectType, QuickSearchFilterTypeGenerator } from './quick-search-filter-input-types/generator';


export const DEFAULT_ARANGOSEARCH_MAX_FILTERABLE_AMOUNT: number = 1000;

/**
 * Augments list fields with filter and pagination features
 */
export class QuickSearchGenerator {


    constructor(
        private readonly quickSearchTypeGenerator: QuickSearchFilterTypeGenerator,
        private readonly outputTypeGenerator: OutputTypeGenerator,
        private readonly listAugmentation: ListAugmentation
    ) {

    }

    generate(rootEntityType: RootEntityType): QueryNodeField {
        const fieldConfig = ({
            name: getQuickSearchEntitiesFieldName(rootEntityType.name),
            type: new QueryNodeListType(new QueryNodeNonNullType(this.outputTypeGenerator.generate(rootEntityType))),
            description: `Searches for ${rootEntityType.pluralName} using QuickSearch.`,
            resolve: () => new QuickSearchQueryNode({ rootEntityType: rootEntityType })
        });
        return this.augmentWithCondition(this.listAugmentation.augment(this.generateFromConfig(fieldConfig, rootEntityType), rootEntityType), rootEntityType);
    }

    generateMeta(rootEntityType: RootEntityType, metaType: QueryNodeObjectType): QueryNodeField {
        const fieldConfig: QueryNodeField = ({
            name: getMetaFieldName(getQuickSearchEntitiesFieldName(rootEntityType.name)),
            type: new QueryNodeNonNullType(metaType),
            description: `Searches for ${rootEntityType.pluralName} using QuickSearch.`,
            // meta fields should never be null. Also, this is crucial for performance. Without it, we would introduce
            // an unnecessary variable with the collection contents (which is slow) and we would to an equality check of
            // a collection against NULL which is deadly (v8 evaluation)
            skipNullCheck: true,
            resolve: () => {
                return new QuickSearchQueryNode({ rootEntityType: rootEntityType }
                );
            }
        });
        return this.generateFromConfig(fieldConfig, rootEntityType);
    }

    generateFromConfig(schemaField: QueryNodeField, rootEntityType: RootEntityType): QueryNodeField {
        if (!rootEntityType.isObjectType) {
            return schemaField;
        }
        const quickSearchType = this.quickSearchTypeGenerator.generate(rootEntityType);
        return {
            ...schemaField,
            args: {
                ...schemaField.args,
                [QUICK_SEARCH_FILTER_ARG]: {
                    type: quickSearchType.getInputType()
                },
                [QUICK_SEARCH_EXPRESSION_ARG]: {
                    type: GraphQLString
                }
            },
            resolve: (sourceNode, args, info) => {
                const itemVariable = new VariableQueryNode(decapitalize(rootEntityType.name));
                const qsFilterNode = this.buildQuickSearchFilterNode(args, quickSearchType, itemVariable, rootEntityType);
                return new QuickSearchQueryNode({
                    rootEntityType: rootEntityType,
                    qsFilterNode: qsFilterNode,
                    itemVariable: itemVariable
                });
            }


        };


    };

    private buildQuickSearchFilterNode(args: { [p: string]: any }, filterType: QuickSearchFilterObjectType, itemVariable: VariableQueryNode, rootEntityType: RootEntityType) {
        const filterValue = args[QUICK_SEARCH_FILTER_ARG] || {};
        const expression = args[QUICK_SEARCH_EXPRESSION_ARG] as string;
        const filterNode = simplifyBooleans(filterType.getFilterNode(itemVariable, filterValue, []));
        const searchFilterNode = simplifyBooleans(this.buildQuickSearchSearchFilterNode(rootEntityType, itemVariable, expression));
        if (searchFilterNode === ConstBoolQueryNode.TRUE) {
            return filterNode;
        } else {
            return simplifyBooleans(new BinaryOperationQueryNode(filterNode, BinaryOperator.AND, searchFilterNode));
        }

    }

    private getPreExecQueryNode(rootEntityType: RootEntityType, args: { [p: string]: any }, context: QueryNodeResolveInfo): QueryNode {
        const itemVariable = new VariableQueryNode(decapitalize(rootEntityType.name));
        const quickSearchType = this.quickSearchTypeGenerator.generate(rootEntityType);
        const qsFilterNode = this.buildQuickSearchFilterNode(args, quickSearchType, itemVariable, rootEntityType);
        return new BinaryOperationQueryNode(
            new CountQueryNode(
                new QuickSearchQueryNode({
                    rootEntityType: rootEntityType,
                    qsFilterNode: qsFilterNode,
                    itemVariable: itemVariable
                })),
            BinaryOperator.GREATER_THAN,
            new LiteralQueryNode(context.arangoSearchMaxFilterableAmountOverride ? context.arangoSearchMaxFilterableAmountOverride : DEFAULT_ARANGOSEARCH_MAX_FILTERABLE_AMOUNT));
    }

    private augmentWithCondition(schemaField: QueryNodeField, rootEntityType: RootEntityType): QueryNodeField {
        return {
            ...schemaField,
            transform: (sourceNode, args, context) => {
                const assertionVariable = new VariableQueryNode();
                if (args[FILTER_ARG] || args[ORDER_BY_ARG]) {
                    return new WithPreExecutionQueryNode({
                        preExecQueries: [
                            new PreExecQueryParms({ resultVariable: assertionVariable, query: this.getPreExecQueryNode(rootEntityType, args, context) })
                        ],
                        resultNode: new ConditionalQueryNode(
                            assertionVariable,
                            new RuntimeErrorQueryNode('Too many objects',{code: 'QUICKSEARCH_TOO_MANY_OBJECTS'}), // @MSF TODO better error message and constant for code in query-tree/errors.ts
                            sourceNode)
                    });
                } else {
                    return sourceNode;
                }

            }
        };
    }

    private buildQuickSearchSearchFilterNode(rootEntityType: RootEntityType, itemVariable: VariableQueryNode, expression: string): QueryNode {
        if (!expression || expression == '') {
            return new ConstBoolQueryNode(true);
        }

        function getQueryNodeFromField(field: Field, path: Field[] = []): QueryNode {
            if (field.type.isObjectType) {
                return field.type.fields.map(value => getQueryNodeFromField(value, path.concat(field))).reduce(or, ConstBoolQueryNode.FALSE);
            }

            function getIdentityNode() {
                if (field.type.isScalarType && field.type && !isNaN(Number(expression))) {
                    return new BinaryOperationQueryNode(new FieldPathQueryNode(itemVariable, path.concat(field)), BinaryOperator.EQUAL, new LiteralQueryNode(Number(expression)));
                } else {
                    return new OperatorWithLanguageQueryNode(new FieldPathQueryNode(itemVariable, path.concat(field)), BinaryOperatorWithLanguage.QUICKSEARCH_STARTS_WITH, new LiteralQueryNode(expression));

                }
            }

            function getOperatorWithLanguageQueryNode() {
                return new OperatorWithLanguageQueryNode(new FieldPathQueryNode(itemVariable, path.concat(field)), BinaryOperatorWithLanguage.QUICKSEARCH_CONTAINS_PREFIX, new LiteralQueryNode(expression), field.language);
            }

            return new BinaryOperationQueryNode(
                field.isQuickSearchIndexed && field.isIncludedInSearch ? getIdentityNode() : ConstBoolQueryNode.FALSE,
                BinaryOperator.OR,
                field.isQuickSearchFulltextIndexed && field.isFulltextIncludedInSearch ? getOperatorWithLanguageQueryNode() : ConstBoolQueryNode.FALSE
            );
        }

        return rootEntityType.fields.filter(value => value.isIncludedInSearch || value.isFulltextIncludedInSearch).map(value => getQueryNodeFromField(value)).reduce(or, ConstBoolQueryNode.FALSE);
    }
}


