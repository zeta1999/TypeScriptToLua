import * as ts from "typescript";
import * as lua from "../../LuaAST";
import { assertNever } from "../../utils";
import { FunctionVisitor, TransformationContext } from "../context";
import { isTupleReturnCall } from "../utils/annotations";
import { validateAssignment } from "../utils/assignment-validation";
import { UnsupportedKind, UnsupportedVarDeclaration } from "../utils/errors";
import { addExportToIdentifier } from "../utils/export";
import { createLocalOrExportedOrGlobalDeclaration, createUnpackCall } from "../utils/lua-ast";
import { LuaLibFeature, transformLuaLibFunction } from "../utils/lualib";
import { transformIdentifier } from "./identifier";
import { transformPropertyName } from "./literal";

export function transformArrayBindingElement(
    context: TransformationContext,
    name: ts.ArrayBindingElement | ts.Expression
): lua.Identifier {
    if (ts.isOmittedExpression(name)) {
        return lua.createAnonymousIdentifier(name);
    } else if (ts.isIdentifier(name)) {
        return transformIdentifier(context, name);
    } else if (ts.isBindingElement(name) && ts.isIdentifier(name.name)) {
        return transformIdentifier(context, name.name);
    } else {
        throw UnsupportedKind("array binding expression", name.kind, name);
    }
}

export function transformBindingPattern(
    context: TransformationContext,
    pattern: ts.BindingPattern,
    table: lua.Identifier,
    propertyAccessStack: ts.PropertyName[] = []
): lua.Statement[] {
    const result: lua.Statement[] = [];
    const isObjectBindingPattern = ts.isObjectBindingPattern(pattern);

    for (const [index, element] of pattern.elements.entries()) {
        if (ts.isOmittedExpression(element)) continue;

        if (ts.isArrayBindingPattern(element.name) || ts.isObjectBindingPattern(element.name)) {
            // nested binding pattern
            const propertyName = isObjectBindingPattern
                ? element.propertyName
                : ts.createNumericLiteral(String(index + 1));

            if (propertyName !== undefined) {
                propertyAccessStack.push(propertyName);
            }

            result.push(...transformBindingPattern(context, element.name, table, propertyAccessStack));
            continue;
        }

        // Build the path to the table
        const tableExpression = propertyAccessStack.reduce<lua.Expression>(
            (path, property) => lua.createTableIndexExpression(path, transformPropertyName(context, property)),
            table
        );

        // The identifier of the new variable
        const variableName = transformIdentifier(context, element.name as ts.Identifier);
        // The field to extract
        const propertyName = transformPropertyName(context, element.propertyName ?? element.name);

        let expression: lua.Expression;
        if (element.dotDotDotToken) {
            if (index !== pattern.elements.length - 1) continue;

            if (isObjectBindingPattern) {
                const elements = pattern.elements as ts.NodeArray<ts.BindingElement>;
                const usedProperties = elements.map(e =>
                    lua.createTableFieldExpression(
                        lua.createBooleanLiteral(true),
                        lua.createStringLiteral(
                            ((e.propertyName ?? e.name) as ts.Identifier).text,
                            e.propertyName ?? e.name
                        )
                    )
                );

                expression = transformLuaLibFunction(
                    context,
                    LuaLibFeature.ObjectRest,
                    undefined,
                    tableExpression,
                    lua.createTableExpression(usedProperties)
                );
            } else {
                expression = transformLuaLibFunction(
                    context,
                    LuaLibFeature.ArraySlice,
                    undefined,
                    tableExpression,
                    lua.createNumericLiteral(index)
                );
            }
        } else {
            expression = lua.createTableIndexExpression(
                tableExpression,
                isObjectBindingPattern ? propertyName : lua.createNumericLiteral(index + 1)
            );
        }

        result.push(...createLocalOrExportedOrGlobalDeclaration(context, variableName, expression));
        if (element.initializer) {
            const identifier = addExportToIdentifier(context, variableName);
            result.push(
                lua.createIfStatement(
                    lua.createBinaryExpression(identifier, lua.createNilLiteral(), lua.SyntaxKind.EqualityOperator),
                    lua.createBlock([
                        lua.createAssignmentStatement(identifier, context.transformExpression(element.initializer)),
                    ])
                )
            );
        }
    }

    propertyAccessStack.pop();
    return result;
}

// TODO: FunctionVisitor<ts.VariableDeclaration>
export function transformVariableDeclaration(
    context: TransformationContext,
    statement: ts.VariableDeclaration
): lua.Statement[] {
    if (statement.initializer && statement.type) {
        const initializerType = context.checker.getTypeAtLocation(statement.initializer);
        const varType = context.checker.getTypeFromTypeNode(statement.type);
        validateAssignment(context, statement.initializer, initializerType, varType);
    }

    if (ts.isIdentifier(statement.name)) {
        // Find variable identifier
        const identifierName = transformIdentifier(context, statement.name);
        const value = statement.initializer && context.transformExpression(statement.initializer);
        return createLocalOrExportedOrGlobalDeclaration(context, identifierName, value, statement);
    } else if (ts.isArrayBindingPattern(statement.name) || ts.isObjectBindingPattern(statement.name)) {
        const statements: lua.Statement[] = [];

        // For object, nested or rest bindings fall back to transformBindingPattern
        if (
            ts.isObjectBindingPattern(statement.name) ||
            statement.name.elements.some(e => ts.isBindingElement(e) && (!ts.isIdentifier(e.name) || e.dotDotDotToken))
        ) {
            let table: lua.Identifier;
            if (statement.initializer !== undefined && ts.isIdentifier(statement.initializer)) {
                table = transformIdentifier(context, statement.initializer);
            } else {
                // Contain the expression in a temporary variable
                table = lua.createAnonymousIdentifier();
                if (statement.initializer) {
                    statements.push(
                        lua.createVariableDeclarationStatement(
                            table,
                            context.transformExpression(statement.initializer)
                        )
                    );
                }
            }
            statements.push(...transformBindingPattern(context, statement.name, table));
            return statements;
        }

        const vars =
            statement.name.elements.length > 0
                ? statement.name.elements.map(e => transformArrayBindingElement(context, e))
                : lua.createAnonymousIdentifier(statement.name);

        if (statement.initializer) {
            if (isTupleReturnCall(context, statement.initializer)) {
                // Don't unpack @tupleReturn annotated functions
                statements.push(
                    ...createLocalOrExportedOrGlobalDeclaration(
                        context,
                        vars,
                        context.transformExpression(statement.initializer),
                        statement
                    )
                );
            } else if (ts.isArrayLiteralExpression(statement.initializer)) {
                // Don't unpack array literals
                const values =
                    statement.initializer.elements.length > 0
                        ? statement.initializer.elements.map(e => context.transformExpression(e))
                        : lua.createNilLiteral();
                statements.push(...createLocalOrExportedOrGlobalDeclaration(context, vars, values, statement));
            } else {
                // local vars = this.transpileDestructingAssignmentValue(node.initializer);
                const initializer = createUnpackCall(
                    context,
                    context.transformExpression(statement.initializer),
                    statement.initializer
                );
                statements.push(...createLocalOrExportedOrGlobalDeclaration(context, vars, initializer, statement));
            }
        } else {
            statements.push(
                ...createLocalOrExportedOrGlobalDeclaration(context, vars, lua.createNilLiteral(), statement)
            );
        }

        for (const element of statement.name.elements) {
            if (!ts.isOmittedExpression(element) && element.initializer) {
                const variableName = transformIdentifier(context, element.name as ts.Identifier);
                const identifier = addExportToIdentifier(context, variableName);
                statements.push(
                    lua.createIfStatement(
                        lua.createBinaryExpression(identifier, lua.createNilLiteral(), lua.SyntaxKind.EqualityOperator),
                        lua.createBlock([
                            lua.createAssignmentStatement(identifier, context.transformExpression(element.initializer)),
                        ])
                    )
                );
            }
        }

        return statements;
    } else {
        return assertNever(statement.name);
    }
}

export function checkVariableDeclarationList(node: ts.VariableDeclarationList): void {
    if ((node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
        throw UnsupportedVarDeclaration(node);
    }
}

export const transformVariableStatement: FunctionVisitor<ts.VariableStatement> = (node, context) => {
    checkVariableDeclarationList(node.declarationList);
    return node.declarationList.declarations.flatMap(declaration => transformVariableDeclaration(context, declaration));
};
