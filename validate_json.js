const fs = require('fs');

try {
  const data = fs.readFileSync('railway_translation_data.json', 'utf8');
  const jsonData = JSON.parse(data);
  
  console.log('✓ JSON格式验证通过');
  console.log(`✓ 总共包含 ${jsonData.length} 条数据`);
  
  const categories = {};
  jsonData.forEach(item => {
    if (!categories[item.category]) {
      categories[item.category] = 0;
    }
    categories[item.category]++;
  });
  
  console.log('\n数据分类统计:');
  Object.keys(categories).forEach(category => {
    console.log(`  - ${category}: ${categories[category]} 条`);
  });
  
  let emptyFields = 0;
  jsonData.forEach(item => {
    if (!item.chinese || !item.indonesian || !item.context) {
      emptyFields++;
    }
  });
  
  if (emptyFields > 0) {
    console.log(`\n⚠ 警告: 发现 ${emptyFields} 条数据有空字段`);
  } else {
    console.log('\n✓ 所有数据字段完整');
  }
  
  console.log('\n数据质量验证完成!');
  
} catch (error) {
  console.error('✗ JSON格式错误:', error.message);
  process.exit(1);
}