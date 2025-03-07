// The module 'vscode' contains the VS Code extensibility API
import * as vscode from 'vscode';

enum PackageType {
  react = 'REACT', // refers to "react" imports
  modules = 'MODULES', // refers to "node_modules" imports
  pathModules = 'PATH_MODULES', // refers to "path_alias" imports
  pathImports = 'PATH_IMPORTS', // refers to "../path" imports
}

// Transformed modular imports string. "{ useState, useEffect as effect }" => { name: useState/useEffect as effect, extractedName: useState/effect }
type IDestructuredModule = {
  displayName: string;
  compareName: string;
};

// Every import string gets converted into following object so that we can easily perform sorting, grouping and comparison.
// If we're sorting based on ascending order then the transformedInput will be like following
// import React as Root, { useState, useEffect as effect } from "react"; =>
// {
//   packageType: 'react',
//   defaultModule: 'React as Root',
//   cleanedDefaultModule: 'Root',
//   packagePath: '"react";',
//   cleanedPackagePath: 'react',
//   hasMultilineImports: false,
//   modules: [
//     { name: 'useState', extractedName: 'useState' },
//     { name: 'useEffect as effect', extractedName: 'effect' },
//   ],
//   mappedString:
//     'import React as Root, { useEffect as effect, useState } from "react";',
// };
type ITransformedImport = {
  packageType: PackageType;
  defaultModule: string;
  packagePath: string;
  modules: IDestructuredModule[];
  cleanedDefaultModule: string;
  cleanedPackagePath: string;
  mappedString?: string;
  hasMultilineImports: boolean;
};

enum SortByConfiguration {
  smaller = '+size',
  larger = '-size',
  ascending = 'a-z',
  descending = 'z-a',
}

// Used to generate import object from import string for internal logic
const generateTransformedImport = (
  importString: string,
  pathImportPrefixes: string[],
): ITransformedImport => {
  const cleanedString = importString
    .trim() // Assume starting line is import React, { useState, useEffect } from "react";
    .replace(/^(\s+)?import(\s+)?/g, '') // Replace "import " with "" => React, { useState, useEffect } from "react";
    .replace(/(\s+)?from(\s+)?/g, '|') // Replace " from  " with "|" => React, { useState, useEffect }|"react";
    .replace(
      /^\w+,?(\s+)?/g,
      (match) => (match.match(/^\w+/g)?.[0] || '') + '|',
    ); // Replace default import "React, " with "React|" => React|{ useState, useEffect }|"react";

  const importArray = cleanedString
    .split('|')
    .filter((value) => !!value.trim());

  const packagePath = importArray.pop() || '';
  const cleanedPackagePath = packagePath.replace(/['";]/g, '');
  const packageType =
    cleanedPackagePath === 'react'
      ? PackageType.react // import is from "react"
      : cleanedPackagePath.startsWith('.')
      ? PackageType.pathImports // import is from relative path "../pages/setting.tsx"
      : cleanedPackagePath.includes('/')
      ? pathImportPrefixes.length &&
        !pathImportPrefixes.includes(cleanedPackagePath.split('/')[0]) // if cleanedPath has "/" then it can be either node module like "@mui/material" or it might be alias like "common/helpers". If user has added "common" in pathImportPrefixes, then it will become pathModules
        ? PackageType.modules
        : PackageType.pathModules
      : pathImportPrefixes.length &&
        pathImportPrefixes.includes(cleanedPackagePath) // if pathImportPrefixes is empty or it doesn't include cleanedPackagePath then it is node module.
      ? PackageType.pathModules
      : PackageType.modules;

  // Default values
  let modules: IDestructuredModule[] = [];
  let defaultModule = '';
  let cleanedDefaultModule = '';
  let hasMultilineImports = false;

  // we've popped last item from ["React", "{ useState, useEffect }", "react"]
  // So currently importArray will contain default and modular imports like ["React", "{ useState, useEffect }"]
  for (let modulesString of importArray) {
    modulesString ??= '';

    if (modulesString.startsWith('{')) {
      // Then it's modular import
      const newModules = modulesString
        .split(/{\s*|,(\s+)?}?(?!\s*as\s*)|\s*}/gm) // Split "{ useState, useEffect }" with curly brackets, comma and spaces
        .filter((value) => !!(value || '').trim()) // Filter out empty values generated by splitting by curly brackets
        .map((value) => ({
          displayName: value,
          compareName: value.replace(/.+as\s+/g, ''),
        })); // Transform them into IDestructuredModule. i.e. useEffect as effect becomes { name: 'useEffect as effect', extractedName: 'effect }

      hasMultilineImports = modulesString.includes('\n');
      modules = modules.concat(newModules);
    } else {
      // It's default import
      defaultModule = modulesString;
      cleanedDefaultModule = modulesString.trim().replace(/.+as\s+/g, ''); // import * as Root becomes "Root"
    }
  }

  return {
    packageType,
    defaultModule,
    modules,
    packagePath,
    cleanedDefaultModule,
    cleanedPackagePath,
    hasMultilineImports,
  };
};

// Used to regenerate import string from sorted import object to write back in VSCode.
const regenerateImportString = (transformedImport: ITransformedImport) => {
  const { defaultModule, modules, packagePath, cleanedDefaultModule } =
    transformedImport;

  const defaultModuleStr = cleanedDefaultModule
    ? `${defaultModule}${modules.length ? ',' : ''} `
    : '';
  const modulesStr = modules.length
    ? `{ ${modules.map((value) => value.displayName).join(', ')} } `
    : '';
  // import "xyz" is plain input because it doesn't contain from keyword!
  const isPlainImport = !cleanedDefaultModule && !modules.length;
  const fromStr = !isPlainImport ? 'from ' : '';

  transformedImport.mappedString = `import ${defaultModuleStr}${modulesStr}${fromStr}${packagePath}`;
};

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const sortHandler = vscode.commands.registerCommand(
    'react-import-sorter.sortReactImports',
    () => {
      // Get the active text editor
      const editor = vscode.window.activeTextEditor;

      // Check if any text is selected
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showErrorMessage('No text selected!');
        return;
      }

      // Extract selected text!
      const selectedText = editor.selections
        .map((selection) => editor.document.getText(selection))
        .join('\n');

      // Matches following pattern
      // import "package"
      // import * as xyz from "package"
      // import default from "package"
      // import default, {module} from "package"
      // import {module} from "package"
      // import default, {
      // 	multilineModule1,
      // 	multilineModule2
      // } from "package"
      const matchedImports =
        selectedText.match(
          /^import\s+((.+)?(\w+)?(,)?(\s+)?({(\w|\d|\s|,)*?})?)(\s+)?(from)?(\s+)?(['"].*['"];?)/gm, // This regex matches above pattern
        ) || [];
      const hasImportText = !!matchedImports.length;

      if (!hasImportText) {
        vscode.window.showErrorMessage(
          "Selected text doesn't seem to contain any imports! If this seems to be a mistake, please raise an issue or contact us.",
        );
        return;
      }

      // Read configurations from workspace settings
      const config = vscode.workspace.getConfiguration();
      const userConfigSortOrders: string[] =
        config.get('reactImportSorter.sortingOrder') || [];
      const userConfigSeparateImportTypes = config.get(
        'reactImportSorter.separateByImportTypes',
      );
      const userConfigSeparateMultilineImports = config.get(
        'reactImportSorter.separateMultilineImports',
      );
      const userConfigSortBy = config.get('reactImportSorter.sortBy');
      const userConfigSortDestructuredModules = config.get(
        'reactImportSorter.sortDestructuredModules',
      );
      const userConfigSortDestructuredModulesBy = config.get(
        'reactImportSorter.sortDestructuredModulesBy',
      );
      const userConfigPathImportPrefixes: string[] =
        config.get('reactImportSorter.pathImportPrefixes') || [];

      // Transform import strings to custom object so we can apply transformations later on!
      const transformedImports = matchedImports.map((importString) =>
        generateTransformedImport(importString, userConfigPathImportPrefixes),
      );

      // Generate package type priorities based on user configurations
      const packageTypeWiseImports: Record<string, ITransformedImport[]> = {};
      let priorityCount = 1;
      for (const sortOrder of userConfigSortOrders) {
        packageTypeWiseImports[sortOrder] ??= [];
        priorityCount++;
      }
      for (const sortOrder of Object.values(PackageType)) {
        packageTypeWiseImports[sortOrder] ??= [];
        priorityCount++;
      }

      // Group based on packageType and sort modular imports if user has enabled it
      for (const transformedImport of transformedImports) {
        const { packageType } = transformedImport;
        if (userConfigSortDestructuredModules) {
          switch (userConfigSortDestructuredModulesBy) {
            case SortByConfiguration.ascending:
              transformedImport.modules = transformedImport.modules.sort(
                (a, b) => a.compareName.localeCompare(b.compareName),
              );
              break;

            case SortByConfiguration.descending:
              transformedImport.modules = transformedImport.modules.sort(
                (a, b) => b.compareName.localeCompare(a.compareName),
              );
              break;

            case SortByConfiguration.smaller:
              transformedImport.modules = transformedImport.modules.sort(
                (a, b) => a.displayName.length - b.displayName.length,
              );
              break;

            case SortByConfiguration.larger:
              transformedImport.modules = transformedImport.modules.sort(
                (a, b) => b.displayName.length - a.displayName.length,
              );
              break;

            default:
              break;
          }
        }
        packageTypeWiseImports[packageType].push(transformedImport);
      }

      // Sort internally grouped imports per packageType.
      for (const packageType of Object.keys(packageTypeWiseImports)) {
        switch (userConfigSortBy) {
          case SortByConfiguration.ascending:
            packageTypeWiseImports[packageType] = packageTypeWiseImports[
              packageType
            ].sort((a, b) =>
              a.cleanedPackagePath.localeCompare(b.cleanedPackagePath),
            );
            break;

          case SortByConfiguration.descending:
            packageTypeWiseImports[packageType] = packageTypeWiseImports[
              packageType
            ].sort((a, b) =>
              b.cleanedPackagePath.localeCompare(a.cleanedPackagePath),
            );
            break;

          default:
            break;
        }

        // We can't sort based on size just yet because we don't have the actual reconstructed import string so first set it so that we can sort based on it
        for (const importObject of packageTypeWiseImports[packageType]) {
          regenerateImportString(importObject);
        }
      }

      // Perform the size based sort as we now have a mappedString
      for (const packageType of Object.keys(packageTypeWiseImports)) {
        switch (userConfigSortBy) {
          case SortByConfiguration.smaller:
            packageTypeWiseImports[packageType] = packageTypeWiseImports[
              packageType
            ].sort(
              (a, b) =>
                (a.mappedString || '').length - (b.mappedString || '').length,
            );
            break;

          case SortByConfiguration.larger:
            packageTypeWiseImports[packageType] = packageTypeWiseImports[
              packageType
            ].sort(
              (a, b) =>
                (b.mappedString || '').length - (a.mappedString || '').length,
            );
            break;

          default:
            break;
        }
      }

      // Generate the final text snipped which we will paste into VSCode on current selection
      const lineSeparators = userConfigSeparateImportTypes ? '\n\n' : '\n';
      const packageTypeWiseDirectImports: string[] = [];
      const replacementText = Object.values(packageTypeWiseImports)
        .filter((value) => value.length) // Remove any packageType which hasn't used in selections
        .map((packageTypeValue) => {
          const directImports: string[] = [];
          const packageTypeWiseImports = packageTypeValue
            .map(
              (
                value, // Each value refers to importObject which has now mappedString which we can use to display in VSCode
              ) => {
                const lineBreakPrefix =
                  userConfigSeparateMultilineImports &&
                  value.hasMultilineImports
                    ? '\n'
                    : '';
                const finalStr = `${lineBreakPrefix}${value.mappedString}`;

                // We want to append direct imports in the end
                const isDirectImport = !value.mappedString?.includes('from ');
                if (isDirectImport && finalStr) {
                  directImports.push(finalStr);
                  return;
                }

                return finalStr.trim();
              },
            )
            .filter(Boolean)
            .join('\n');

          const joinedDirectImports = directImports.join('\n');
          if (joinedDirectImports) {
            packageTypeWiseDirectImports.push(joinedDirectImports);
          }

          return packageTypeWiseImports;
        })
        .join(lineSeparators);
      const directImportsReplacementText =
        packageTypeWiseDirectImports.join(lineSeparators);

      const textToReplaceInEditor =
        replacementText +
        (directImportsReplacementText
          ? `${lineSeparators}${directImportsReplacementText}`
          : '');

      // Replace the selected text with a custom value from a variable
      editor.edit((builder) => {
        // Sort all selections based on their line numbers!
        const selections = [...editor.selections].sort(
          ({ start: { line: selLine1 } }, { start: { line: selLine2 } }) =>
            selLine1 - selLine2,
        );

        // Apply whole sorted imports on top selection
        const topmostSelection = selections[0];
        builder.replace(topmostSelection, textToReplaceInEditor);

        // Remove the remaining selections
        const deletedLines: Set<number> = new Set();

        for (let i = 1; i < selections.length; i++) {
          const selection = selections[i];
          const isWholeLineSelected =
            selection.start.character === 0 &&
            selection.end.character ===
              editor.document.lineAt(selection.end.line).range.end.character;

          // If whole line is selected, That means the selection would result in blank line after replacement,
          // If so delete such lines otherwise only delete the selection.
          if (isWholeLineSelected) {
            const lineToDelete = selection.start.line;
            if (!deletedLines.has(lineToDelete)) {
              deletedLines.add(lineToDelete);
              builder.delete(
                new vscode.Range(lineToDelete, 0, lineToDelete + 1, 0),
              );
            }
          } else {
            builder.delete(selection);
          }
        }

        // Move the cursor to the latest replaced selection's end!
        editor.selection = new vscode.Selection(
          topmostSelection.end,
          topmostSelection.end,
        );
      });
    },
  );

  // File save event listener
  const saveHandler = vscode.workspace.onDidSaveTextDocument((document) => {
    const config = vscode.workspace.getConfiguration();
    const runOnSave = config.get('reactImportSorter.runOnSave');

    if (runOnSave) {
      vscode.commands.executeCommand('react-import-sorter.sortReactImports');
    }
  });

  context.subscriptions.push(sortHandler, saveHandler);
}

// This method is called when your extension is deactivated
export function deactivate() {}
