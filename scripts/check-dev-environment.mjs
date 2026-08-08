#!/usr/bin/env node

import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

async function checkDevelopmentEnvironment() {
  console.log('🔍 Checking development environment...\n');
  
  const issues = [];
  let exitCode = 0;
  
  // Check Node.js version
  try {
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.split('.')[0].replace('v', ''));
    if (majorVersion < 22) {
      issues.push(`Node.js version ${nodeVersion} is outdated. Requires >=22.13.0`);
      exitCode = 1;
    } else {
      console.log('✅ Node.js version:', nodeVersion);
    }
  } catch (error) {
    issues.push('Failed to check Node.js version');
    exitCode = 1;
  }
  
  // Check npm version
  try {
    const npmVersion = execSync('npm --version').toString().trim();
    console.log('✅ npm version:', npmVersion);
  } catch (error) {
    issues.push('Failed to check npm version');
    exitCode = 1;
  }
  
  // Check if server directory exists
  try {
    const serverExists = await fs.access('./server').then(() => true, () => false);
    if (!serverExists) {
      issues.push('Server directory not found');
      exitCode = 1;
    } else {
      console.log('✅ Server directory exists');
    }
  } catch (error) {
    issues.push('Failed to check server directory');
    exitCode = 1;
  }
  
  // Check if package.json files are valid
  try {
    const mainPackage = JSON.parse(await fs.readFile('./package.json', 'utf8'));
    const serverPackage = JSON.parse(await fs.readFile('./server/package.json', 'utf8'));
    console.log('✅ Package.json files are valid');
  } catch (error) {
    issues.push('Failed to validate package.json files: ' + error.message);
    exitCode = 1;
  }
  
  // Check TypeScript version consistency
  try {
    const mainPackage = JSON.parse(await fs.readFile('./package.json', 'utf8'));
    const serverPackage = JSON.parse(await fs.readFile('./server/package.json', 'utf8'));
    
    const mainTsVersion = mainPackage.devDependencies?.typescript || mainPackage.dependencies?.typescript;
    const serverTsVersion = serverPackage.devDependencies?.typescript || serverPackage.dependencies?.typescript;
    
    if (mainTsVersion && serverTsVersion && mainTsVersion !== serverTsVersion) {
      issues.push(`TypeScript version mismatch: dashboard=${mainTsVersion}, collector=${serverTsVersion}`);
      exitCode = 1;
    } else {
      console.log('✅ TypeScript versions are consistent');
    }
  } catch (error) {
    // Don't fail on this, just log a warning
    console.warn('⚠️  Could not check TypeScript version consistency');
  }
  
  // Check for common missing dev dependencies
  try {
    const mainPackage = JSON.parse(await fs.readFile('./package.json', 'utf8'));
    const requiredDevDeps = ['typescript', '@types/node'];
    
    const missingDeps = requiredDevDeps.filter(dep => 
      !mainPackage.devDependencies?.[dep] && !mainPackage.dependencies?.[dep]
    );
    
    if (missingDeps.length > 0) {
      issues.push(`Missing required dev dependencies: ${missingDeps.join(', ')}`);
      exitCode = 1;
    } else {
      console.log('✅ Required dev dependencies are present');
    }
  } catch (error) {
    issues.push('Failed to check dev dependencies: ' + error.message);
    exitCode = 1;
  }
  
  // Display results
  if (issues.length > 0) {
    console.log('\n❌ Issues found:\n');
    issues.forEach((issue, index) => {
      console.log(`${index + 1}. ${issue}`);
    });
    console.log('\nPlease fix these issues before continuing.\n');
  } else {
    console.log('\n✅ All development environment checks passed!\n');
  }
  
  return exitCode;
}

checkDevelopmentEnvironment().then(exitCode => process.exit(exitCode)).catch(error => {
  console.error('❌ Environment check failed:', error.message);
  process.exit(1);
});